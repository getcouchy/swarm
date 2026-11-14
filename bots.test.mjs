// node --test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  appJwt, botEmail, credentialAnswer, envExports, exportBlock, identityFromEnv, installationToken, loadIdentity,
  manifest, saveIdentity, tokenCache,
} from './bots.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
const NOW = Date.parse('2026-11-10T12:00:00Z');
const id = { agent: 'codex', appId: 42, slug: 'couchy-codex', userId: 9001, pem };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bots-'));

test('the manifest asks for a private app with repo permissions and no webhook', () => {
  const m = manifest('claude-2', { redirectUrl: 'http://127.0.0.1:8787/callback', org: 'getcouchy' });
  assert.equal(m.name, 'couchy-claude-2');
  assert.equal(m.public, false);
  assert.equal(m.hook_attributes.active, false);
  assert.equal(m.default_permissions.contents, 'write');
  assert.equal(m.default_permissions.administration, undefined, 'nothing org-wide');
  assert.ok(m.name.length <= 34, 'GitHub caps app names at 34');
});

test('the app JWT is RS256, signed by the key, issued by the app, ten minutes long', () => {
  const [h, b, sig] = appJwt({ appId: 42, pem, now: NOW }).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const body = JSON.parse(Buffer.from(b, 'base64url'));
  assert.equal(body.iss, '42');
  assert.equal(body.exp - body.iat, 600);
  assert.ok(body.iat < NOW / 1000, 'backdated for clock drift');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(sig, 'base64url')));
});

test('an installation token is minted once and reused while it has time left', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    assert.match(init.headers.Authorization, /^Bearer ey/);
    const body = url.endsWith('/orgs/getcouchy/installation') ? { id: 7 } : { token: 'ghs_x', expires_at: new Date(NOW + 3_600_000).toISOString() };
    return { ok: true, status: 200, json: async () => body };
  };
  let saved = null;
  const cache = { read: () => saved, write: (t) => { saved = t; } };
  assert.equal((await installationToken(id, { org: 'getcouchy', fetchImpl, now: NOW, cache })).token, 'ghs_x');
  assert.deepEqual(calls, ['GET https://api.github.com/orgs/getcouchy/installation', 'POST https://api.github.com/app/installations/7/access_tokens']);
  await installationToken(id, { org: 'getcouchy', fetchImpl, now: NOW + 30 * 60_000, cache });
  assert.equal(calls.length, 2, 'cached');
  await installationToken(id, { org: 'getcouchy', fetchImpl, now: NOW + 58 * 60_000, cache });
  assert.equal(calls.length, 4, 'refreshed near expiry');
});

test('an app not installed yet says where to install it', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
  await assert.rejects(installationToken(id, { org: 'getcouchy', fetchImpl, now: NOW }), /installations\/new/);
});

test('commits carry the bot noreply address', () => {
  assert.equal(botEmail(id), '9001+couchy-codex[bot]@users.noreply.github.com');
  const out = envExports(id, 'ghs_x', {});
  assert.match(out, /^export GH_TOKEN='ghs_x'$/m);
  assert.match(out, /^export AGENT_NAME='codex'$/m);
  assert.match(out, /^export GIT_AUTHOR_NAME='couchy-codex\[bot\]'$/m);
  assert.match(out, /^export GIT_COMMITTER_EMAIL='9001\+couchy-codex\[bot\]@users\.noreply\.github\.com'$/m);
});

test('an identity survives the trip through export and the environment', () => {
  const env = Object.fromEntries(exportBlock(id).split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.ok(!exportBlock(id).includes('BEGIN'), 'the key is one base64 line');
  assert.deepEqual(identityFromEnv(env), id);
  assert.equal(identityFromEnv({}), null);
  const { COUCHY_BOT_AGENT, ...noAgent } = env;
  assert.throws(() => identityFromEnv(noAgent), /COUCHY_BOT_AGENT/);
});

test('env refuses to rename an agent the prompt already named', () => {
  assert.throws(() => envExports(id, 't', { AGENT_NAME: 'claude-2' }), /AGENT_NAME is claude-2/);
  assert.match(envExports(id, 't', { AGENT_NAME: 'codex' }), /AGENT_NAME='codex'/);
});

test('a sandbox caches tokens only in a private directory, never through a planted file', () => {
  const dir = tmp();
  const env = { COUCHY_BOTS_DIR: dir };
  const cache = tokenCache(id, env);
  const file = path.join(dir, 'tokens', '42.json');
  assert.equal(fs.statSync(path.join(dir, 'tokens')).mode & 0o777, 0o700);
  fs.writeFileSync(file, JSON.stringify({ token: 'PLANTED', expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.equal(cache.read(), null, 'a file others could write is ignored');
  const target = path.join(dir, 'elsewhere');
  fs.rmSync(file);
  fs.symlinkSync(target, file);
  cache.write({ token: 'real', expires_at: '2099-01-01T00:00:00Z' });
  assert.ok(!fs.existsSync(target), 'the link was replaced, not followed');
  assert.equal(cache.read().token, 'real');
  fs.chmodSync(path.join(dir, 'tokens'), 0o777);
  assert.equal(tokenCache(id, env), null, 'a directory others can write is not used');
});

test('saved identities keep the key private', () => {
  const dir = tmp();
  saveIdentity(dir, 'codex', { id: 42, slug: 'couchy-codex', client_id: 'Iv1', pem, html_url: 'u' }, 9001);
  assert.equal(fs.statSync(path.join(dir, 'codex', 'private-key.pem')).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(dir, 'codex', 'app.json'), 'utf8').includes('PRIVATE'));
  assert.equal(loadIdentity(dir, 'codex').pem, pem);
  assert.throws(() => loadIdentity(dir, 'grok'), /bots\.mjs create grok/);
});

test('the credential helper answers only for github.com', () => {
  assert.equal(credentialAnswer('protocol=https\nhost=github.com\n', 't'), 'username=x-access-token\npassword=t\n');
  assert.equal(credentialAnswer('protocol=https\nhost=gitlab.com\n', 't'), '');
});

test('git-setup points a clone at the bot', () => {
  const repo = tmp();
  execFileSync('git', ['init', '-q', repo]);
  const env = { ...process.env, ...Object.fromEntries(exportBlock(id).split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) };
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bots.mjs');
  execFileSync('node', [cli, 'git-setup'], { cwd: repo, env, stdio: 'pipe' });
  const get = (k) => execFileSync('git', ['config', '--local', '--get-all', k], { cwd: repo, encoding: 'utf8' }).trimEnd().split('\n');
  assert.deepEqual(get('user.name'), ['couchy-codex[bot]']);
  const helpers = get('credential.https://github.com.helper');
  assert.equal(helpers[0], '', 'inherited helpers are dropped');
  assert.match(helpers[1], /bots\.mjs" git-credential$/);
});
