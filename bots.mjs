#!/usr/bin/env node
// A GitHub identity of its own for each agent (see README.md in getcouchy/swarm).
//
// Each agent name (codex, grok, claude-2…) gets a private GitHub App in the
// org, `couchy-<name>`, which comments, reviews and pushes as
// `couchy-<name>[bot]`. Nothing here needs a dependency beyond Node 20+.
//
//   node ../swarm/bots.mjs create codex       make the app (two clicks in a browser)
//   node ../swarm/bots.mjs list               the apps made on this machine, and whether each is installed
//   node ../swarm/bots.mjs export codex       the secrets to give the agent's sandbox
//   node ../swarm/bots.mjs check [codex]      mint a token and list the repos it reaches
//   node ../swarm/bots.mjs token [codex]      a one-hour installation token
//   eval "$(node ../swarm/bots.mjs env [codex])"   GH_TOKEN, AGENT_NAME and the git author, as exports
//   node ../swarm/bots.mjs git-setup [codex]  this clone commits and pushes as the bot
//
// Leave the name out inside a sandbox that has the COUCHY_BOT_* variables
// `export` printed; with a name, the app is read from COUCHY_BOTS_DIR
// (~/.config/couchy-bots/<name>/). COUCHY_ORG defaults to getcouchy.

import { createSign, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { agentFromLogin, isValidProvider } from './rules.mjs';

const API = 'https://api.github.com';
const HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'couchy-bots' };

/** The app's name and its bot's login stem: `couchy-codex` → `couchy-codex[bot]`. */
export const appName = (agent) => `couchy-${agent}`;

export { agentFromLogin };

/** What an agent's app may do: the agent protocol and ordinary PR work, nothing org-wide. */
export const PERMISSIONS = {
  contents: 'write', // push branches
  pull_requests: 'write', // open PRs, review, comment on lines
  issues: 'write', // labels, claims, comments, the heartbeat
  workflows: 'write', // PRs that touch .github/workflows
  checks: 'read',
  statuses: 'read',
  actions: 'read', // read CI logs to fix a red PR
  metadata: 'read',
};

/** The manifest GitHub's "create from manifest" flow takes. */
export function manifest(agent, { redirectUrl, org }) {
  return {
    name: appName(agent),
    url: `https://github.com/${org}`,
    description: `The ${agent} coding agent's identity in ${org}. Made by getcouchy/swarm bots.mjs.`,
    public: false, // only this org can install it
    redirect_url: redirectUrl,
    hook_attributes: { url: `https://github.com/${org}`, active: false }, // no webhooks
    default_permissions: PERMISSIONS,
    default_events: [],
  };
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** An app JWT (RS256, ten minutes, backdated a minute for clock drift). */
export function appJwt({ appId, pem, now = Date.now() }) {
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 600, iss: String(appId) }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(pem);
  return `${head}.${body}.${b64url(sig)}`;
}

/** The address GitHub credits a bot's commits to, so they link to its profile. */
export const botEmail = ({ slug, userId }) => `${userId}+${slug}[bot]@users.noreply.github.com`;

/** The git author and committer an identity's commits carry. */
export function gitIdentity(id) {
  if (!id.userId) throw new Error(`no bot user id for ${id.slug}; run: node ../swarm/bots.mjs check ${id.agent}`);
  return { name: `${id.slug}[bot]`, email: botEmail(id) };
}

async function gh(fetchImpl, method, url, { token, jwt, body } = {}) {
  const auth = token ? { Authorization: `Bearer ${token}` } : jwt ? { Authorization: `Bearer ${jwt}` } : {};
  const res = await fetchImpl(url.startsWith('http') ? url : `${API}${url}`, {
    method,
    headers: { ...HEADERS, ...auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

/** Trade the manifest flow's one-time code for the new app: id, slug, pem… */
export const convertManifest = (code, { fetchImpl = fetch } = {}) =>
  gh(fetchImpl, 'POST', `/app-manifests/${encodeURIComponent(code)}/conversions`);

/** The bot account's user id, which its commit email needs. */
export async function botUserId(slug, { fetchImpl = fetch } = {}) {
  return (await gh(fetchImpl, 'GET', `/users/${encodeURIComponent(`${slug}[bot]`)}`)).id;
}

/** The app's installation on the org, or null if it isn't installed yet. */
export async function orgInstallation(id, { org, fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    return await gh(fetchImpl, 'GET', `/orgs/${org}/installation`, { jwt: appJwt({ ...id, now }) });
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/**
 * A one-hour installation token for the org, reused from `cache` while it has
 * five minutes left.
 */
export async function installationToken(id, { org, fetchImpl = fetch, now = Date.now(), cache } = {}) {
  const cached = cache?.read();
  if (cached?.token && Date.parse(cached.expires_at) - now > 5 * 60_000) return cached;
  const inst = await orgInstallation(id, { org, fetchImpl, now });
  if (!inst) throw new Error(`${id.slug} is not installed on ${org}: https://github.com/apps/${id.slug}/installations/new`);
  const tok = await gh(fetchImpl, 'POST', `/app/installations/${inst.id}/access_tokens`, { jwt: appJwt({ ...id, now }) });
  const out = { token: tok.token, expires_at: tok.expires_at };
  cache?.write(out);
  return out;
}

// ---- where identities live ----

export const botsDir = (env = process.env) => env.COUCHY_BOTS_DIR || path.join(os.homedir(), '.config', 'couchy-bots');

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Save a new app: app.json (ids, no secrets) and private-key.pem, both 0600. */
export function saveIdentity(dir, agent, app, userId) {
  const id = { agent, appId: app.id, slug: app.slug, clientId: app.client_id, userId, htmlUrl: app.html_url };
  writePrivate(path.join(dir, agent, 'app.json'), `${JSON.stringify(id, null, 2)}\n`);
  writePrivate(path.join(dir, agent, 'private-key.pem'), app.pem);
  return { ...id, pem: app.pem };
}

export function loadIdentity(dir, agent) {
  const base = path.join(dir, agent);
  if (!fs.existsSync(path.join(base, 'app.json'))) {
    throw new Error(`no app for ${agent} in ${dir}; make one with: node ../swarm/bots.mjs create ${agent}`);
  }
  const id = JSON.parse(fs.readFileSync(path.join(base, 'app.json'), 'utf8'));
  return { ...id, pem: fs.readFileSync(path.join(base, 'private-key.pem'), 'utf8') };
}

/** The COUCHY_BOT_* lines a sandbox needs, the key base64'd onto one line. */
export function exportBlock(id) {
  return [
    `COUCHY_BOT_AGENT=${id.agent}`,
    `COUCHY_BOT_APP_ID=${id.appId}`,
    `COUCHY_BOT_SLUG=${id.slug}`,
    `COUCHY_BOT_USER_ID=${id.userId ?? ''}`,
    `COUCHY_BOT_KEY=${Buffer.from(id.pem).toString('base64')}`,
  ].join('\n');
}

/** An identity from COUCHY_BOT_* variables, or null if they aren't set. */
export function identityFromEnv(env = process.env) {
  if (!env.COUCHY_BOT_APP_ID || !env.COUCHY_BOT_KEY) return null;
  if (!isValidProvider(env.COUCHY_BOT_AGENT)) throw new Error('COUCHY_BOT_AGENT is missing or not an agent name; set all five lines `bots.mjs export` prints');
  const key = env.COUCHY_BOT_KEY.trim();
  return {
    agent: env.COUCHY_BOT_AGENT,
    appId: Number(env.COUCHY_BOT_APP_ID),
    slug: env.COUCHY_BOT_SLUG || appName(env.COUCHY_BOT_AGENT),
    userId: env.COUCHY_BOT_USER_ID ? Number(env.COUCHY_BOT_USER_ID) : null,
    pem: key.startsWith('-----BEGIN') ? key.replace(/\\n/g, '\n') : Buffer.from(key, 'base64').toString('utf8'),
  };
}

/**
 * Shell exports that make gh, the agent tools and git act as the bot. The
 * prompt names the agent (PROTOCOL.md), so a different AGENT_NAME already set is
 * an error, not something to overwrite.
 */
export function envExports(id, token, env = process.env) {
  if (env.AGENT_NAME && env.AGENT_NAME !== id.agent) {
    throw new Error(`AGENT_NAME is ${env.AGENT_NAME} but these secrets are ${id.slug}'s (agent ${id.agent}); give this agent its own bot`);
  }
  const { name, email } = gitIdentity(id);
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  return [
    ['GH_TOKEN', token],
    ['GITHUB_TOKEN', token],
    ['AGENT_NAME', id.agent],
    ['GIT_AUTHOR_NAME', name],
    ['GIT_AUTHOR_EMAIL', email],
    ['GIT_COMMITTER_NAME', name],
    ['GIT_COMMITTER_EMAIL', email],
  ].map(([k, v]) => `export ${k}=${q(v)}`).join('\n');
}

/** git's credential-helper answer: the token for github.com, nothing for other hosts. */
export function credentialAnswer(request, token) {
  const fields = Object.fromEntries(request.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  if (fields.host && fields.host !== 'github.com') return '';
  return `username=x-access-token\npassword=${token}\n`;
}

// ---- the CLI ----

function resolveIdentity(agent, env = process.env) {
  if (agent) return loadIdentity(botsDir(env), agent);
  const id = identityFromEnv(env);
  if (!id) throw new Error('name an agent, or set the COUCHY_BOT_* variables `bots.mjs export <name>` prints');
  return id;
}

/** A directory only this user can use, or null: it must be ours, a real directory and 0700. */
export function privateDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    const mine = typeof process.getuid !== 'function' || st.uid === process.getuid();
    return st.isDirectory() && mine && (st.mode & 0o077) === 0 ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Where a token is cached: beside the app on the machine that made it, else in
 * COUCHY_BOTS_DIR/tokens/ (never a shared temp directory). With no private
 * place to put it, nothing is cached and every call mints.
 */
export function tokenCache(id, env = process.env) {
  const local = id.agent && fs.existsSync(path.join(botsDir(env), id.agent, 'app.json'));
  const dir = privateDir(local ? path.join(botsDir(env), id.agent) : path.join(botsDir(env), 'tokens'));
  if (!dir) return null;
  const file = path.join(dir, local ? 'token.json' : `${id.appId}.json`);
  return {
    read: () => {
      try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || (st.mode & 0o077) !== 0) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch { return null; }
    },
    write: (t) => {
      fs.rmSync(file, { force: true }); // never write through a link someone left
      fs.writeFileSync(file, JSON.stringify(t), { mode: 0o600, flag: 'wx' });
    },
  };
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* print the URL instead */ }
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Run the manifest flow on localhost: one click to create, one to install. */
async function create(agent, { org, port, dir }) {
  if (fs.existsSync(path.join(dir, agent, 'app.json'))) throw new Error(`${agent} already has an app in ${dir}`);
  const state = randomBytes(16).toString('hex');
  const redirectUrl = `http://127.0.0.1:${port}/callback`;
  const json = JSON.stringify(manifest(agent, { redirectUrl, org }));
  const action = `https://github.com/organizations/${org}/settings/apps/new?state=${state}`;
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, redirectUrl);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Create ${appName(agent)}</title>
<form method="post" action="${action}"><input type="hidden" name="manifest" value="${escapeHtml(json)}">
<p>Creating the GitHub App <b>${appName(agent)}</b> in <b>${org}</b>…</p><button>Continue to GitHub</button></form>
<script>document.forms[0].submit()</script>`);
        return;
      }
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      if (url.searchParams.get('state') !== state) { res.writeHead(400).end('state does not match; start again'); return; }
      if (!url.searchParams.get('code')) { res.writeHead(400).end('GitHub sent no code; start again'); return; }
      try {
        const app = await convertManifest(url.searchParams.get('code'));
        let userId = null;
        try { userId = await botUserId(app.slug); } catch { /* `check` fills it in later */ }
        const id = saveIdentity(dir, agent, app, userId);
        const install = `https://github.com/apps/${app.slug}/installations/new`;
        res.writeHead(302, { Location: install }).end();
        console.log(`made ${app.slug} (app id ${app.id}); saved to ${path.join(dir, agent)}`);
        console.log(`\nNext, in the browser: install it on ${org} and pick its repositories (${install}).`);
        console.log(`Then: node ../swarm/bots.mjs check ${agent}`);
        server.close();
        resolve(id);
      } catch (e) {
        res.writeHead(500).end(String(e.message));
        server.close();
        reject(e);
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const start = `http://127.0.0.1:${port}/`;
      console.log(`Open ${start} if a browser doesn't open, and click "Create GitHub App for ${org}".`);
      openBrowser(start);
    });
  });
}

async function main(argv, env = process.env) {
  const [cmd, ...rest] = argv;
  const flags = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
  const [agent, ...more] = rest.filter((a) => !a.startsWith('--'));
  const org = env.COUCHY_ORG || 'getcouchy';
  const dir = botsDir(env);
  if (agent && cmd !== 'git-credential' && !isValidProvider(agent)) {
    throw new Error(`"${agent}" is not an agent name: lower-case letters, digits and hyphens (see PROTOCOL.md)`);
  }

  switch (cmd) {
    case 'create':
      if (!agent) throw new Error('usage: bots.mjs create <agent>');
      if (appName(agent).length > 34) throw new Error(`"${agent}" is too long: GitHub caps app names at 34 characters, so a name may have 27`);
      await create(agent, { org, port: Number(flags.port ?? 8787), dir });
      return;
    case 'list': {
      const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'app.json'))) : [];
      if (!names.length) console.log(`no apps in ${dir}`);
      for (const name of names) {
        const id = loadIdentity(dir, name);
        const inst = await orgInstallation(id, { org }).catch((e) => ({ error: e.message }));
        const state = inst?.error ? `error: ${inst.error}` : inst ? `installed (${inst.repository_selection} repositories)` : 'not installed';
        console.log(`${name.padEnd(20)} ${`${id.slug}[bot]`.padEnd(32)} app ${id.appId}  ${state}`);
      }
      return;
    }
    case 'export': {
      if (!agent) throw new Error('usage: bots.mjs export <agent>');
      const id = loadIdentity(dir, agent);
      if (!id.userId) throw new Error(`run check ${agent} first, so the export carries the bot's user id`);
      console.log(exportBlock(id));
      return;
    }
    case 'check': {
      const id = resolveIdentity(agent, env);
      if (!id.userId) {
        id.userId = await botUserId(id.slug);
        if (agent) {
          const file = path.join(dir, agent, 'app.json');
          writePrivate(file, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), userId: id.userId }, null, 2)}\n`);
        }
      }
      const { token } = await installationToken(id, { org, cache: tokenCache(id, env) });
      const { repositories } = await gh(fetch, 'GET', '/installation/repositories?per_page=100', { token });
      const who = gitIdentity(id);
      console.log(`${id.slug}[bot] for agent ${id.agent}`);
      console.log(`git author: ${who.name} <${who.email}>`);
      console.log(`repositories: ${repositories.map((r) => r.full_name).join(', ') || 'none; add some on the installation page'}`);
      return;
    }
    case 'token': {
      const id = resolveIdentity(agent, env);
      console.log((await installationToken(id, { org, cache: tokenCache(id, env) })).token);
      return;
    }
    case 'env': {
      const id = resolveIdentity(agent, env);
      console.log(envExports(id, (await installationToken(id, { org, cache: tokenCache(id, env) })).token, env));
      return;
    }
    case 'git-setup': {
      const id = resolveIdentity(agent, env);
      const { name, email } = gitIdentity(id);
      const self = fileURLToPath(import.meta.url);
      const helper = `!node ${JSON.stringify(self)} git-credential${agent ? ` ${agent}` : ''}`;
      const git = (...a) => execFileSync('git', ['config', '--local', ...a], { stdio: ['ignore', 'pipe', 'inherit'] });
      git('user.name', name);
      git('user.email', email);
      try { git('--unset-all', 'credential.https://github.com.helper'); } catch { /* none set */ }
      git('--add', 'credential.https://github.com.helper', ''); // drop inherited helpers for github.com
      git('--add', 'credential.https://github.com.helper', helper);
      console.log(`this clone now commits as ${name} <${email}> and pushes with ${id.slug}'s token`);
      return;
    }
    case 'git-credential': {
      // git runs "<helper> get|store|erase" with the request on stdin.
      const action = more.at(-1) ?? agent;
      const named = agent && agent !== action ? agent : undefined;
      if (action !== 'get') return;
      const request = fs.readFileSync(0, 'utf8');
      const id = resolveIdentity(named, env);
      process.stdout.write(credentialAnswer(request, (await installationToken(id, { org, cache: tokenCache(id, env) })).token));
      return;
    }
    default:
      console.error(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1).filter((l, i, all) => all.slice(0, i + 1).every((x) => x.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      process.exitCode = cmd ? 1 : 0;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`bots: ${e.message}`);
    process.exit(1);
  });
}
