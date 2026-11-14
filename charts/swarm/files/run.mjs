// Runs one script from SOURCE_REF of SOURCE_REPOSITORY as the swarm's GitHub App:
// mints a one-hour installation token for GITHUB_REPOSITORY (the repository the
// script works on), downloads and unpacks the source ref's tarball, then runs
// `node <script> [args]` from the source's root with the token in GITHUB_TOKEN
// and the other token variables the scripts read. SOURCE_REPOSITORY defaults
// to GITHUB_REPOSITORY. Node 20+, no dependencies.
import { createSign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';

const { SWARM_APP_ID: appId, SWARM_APP_KEY: key, GITHUB_REPOSITORY: repo, SOURCE_REF: ref = 'main' } = process.env;
const source = process.env.SOURCE_REPOSITORY || repo;
const [script, ...args] = process.argv.slice(2);
if (!appId || !key || !repo || !script) {
  console.error('Needs SWARM_APP_ID, SWARM_APP_KEY, GITHUB_REPOSITORY and a script to run.');
  process.exit(2);
}

const API = 'https://api.github.com';
const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'swarm-chart' };
const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const pem = key.includes('BEGIN') ? key : Buffer.from(key, 'base64').toString('utf8');
  return `${body}.${createSign('RSA-SHA256').update(body).sign(pem, 'base64url')}`;
}

async function gh(method, path, auth) {
  const res = await fetch(`${API}${path}`, { method, headers: { ...headers, Authorization: auth } });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

const jwt = `Bearer ${appJwt()}`;
const inst = await (await gh('GET', `/repos/${repo}/installation`, jwt)).json();
const { token } = await (await gh('POST', `/app/installations/${inst.id}/access_tokens`, jwt)).json();

const src = '/tmp/src';
mkdirSync(src, { recursive: true });
// The token is for GITHUB_REPOSITORY's installation: another source must be
// public or in the same installation.
const tarball = await gh('GET', `/repos/${source}/tarball/${encodeURIComponent(ref)}`, `Bearer ${token}`);
writeFileSync('/tmp/src.tgz', Buffer.from(await tarball.arrayBuffer()));
// BusyBox tar may lack --strip-components; the tarball holds one top directory.
const untar = spawnSync('tar', ['-xzf', '/tmp/src.tgz', '-C', src], { stdio: 'inherit' });
if (untar.status !== 0) process.exit(untar.status ?? 1);
const [top] = readdirSync(src);
const root = `${src}/${top}`;

const tokens = Object.fromEntries(['GITHUB_TOKEN', 'GH_TOKEN', 'READ_TOKEN', 'POST_TOKEN', 'PROJECT_TOKEN'].map((k) => [k, token]));
const env = { ...process.env, ...tokens, SWARM_APP_KEY: '' };
const run = spawnSync(process.execPath, [script, ...args], { cwd: root, env, stdio: 'inherit' });
process.exit(run.status ?? 1);
