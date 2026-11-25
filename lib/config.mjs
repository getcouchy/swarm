// One deployment's settings, read once: which repositories the swarm works
// in, what its labels are called, how long a tick and a lock last, where the
// work items are. The rules (rules.mjs) and every tool take their names and
// numbers from here, and the protocol's documents are rendered from the same
// values (render.mjs), so what an agent reads and what the tools enforce can't
// drift apart.
//
// The file is JSON: SWARM_CONFIG when that is set, else swarm.config.json
// beside the tools. It is read from the tools' own directory, never from the
// checkout a tick works in: a pull request must not be able to change the
// rules that guard its own merge. With no file the protocol's own defaults
// apply and nothing names a repository: GITHUB_REPOSITORY and the tracker's
// variables must then say where the work is.
//
// What the environment still sets is each tick's own (AGENT_NAME, AGENT_ROLE,
// AGENT_CAN, the tick's times) and every credential. Where a variable and the
// file both give a value, the variable wins.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The directory the tools are in: the parent of lib/. */
export const toolsRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The protocol's labels by the name the code knows each under, and what each
 * is called after the namespace unless `labels.names` says otherwise. `agent`
 * and `needs` are prefixes: a lock is `<namespace>agent/<name>`.
 */
export const LABEL_NAMES = {
  needsHuman: 'needs-human',
  hold: 'hold',
  focus: 'focus',
  qa: 'qa',
  blocked: 'blocked',
  taskBreakdown: 'task-breakdown',
  design: 'design',
  techDesign: 'tech-design',
  desk: 'desk',
  agent: 'agent/',
  needs: 'needs/',
  pr: 'pr',
  handsOff: 'hands-off',
  reviewOnly: 'review-only',
};
const PREFIXES = ['agent', 'needs'];

export const DEFAULTS = {
  // What a page calls this swarm ("<name> needs you").
  name: 'Swarm',
  // The person the agents answer to, as the documents name them.
  owner: null,
  // owner/name of the repository these tools are cloned from, for the documents and messages.
  toolsRepo: null,
  // The repositories the swarm works in, the home repository first. GITHUB_REPOSITORY and AGENT_REPOS win.
  repos: [],
  // The repository designs and technical designs are written in, when there is one.
  designRepo: null,
  // The branch pull requests merge into.
  baseBranch: 'main',
  labels: {
    // Every label the protocol owns starts with this, so a person can tell them from the product's.
    namespace: 'swarm/',
    // Another name for one of LABEL_NAMES, after the namespace: { "hold": "wait" }.
    names: {},
    // The label CI puts on a pull request that conflicts with the base branch.
    conflict: 'conflicts-with-main',
    // Names labels had before, still read and renamed by the sweep: { "merge/hold": "hold", "agent/": "agent" }.
    aliases: {},
  },
  // The commit status reviewed.mjs writes, which a branch rule can require.
  review: { status: 'reviewed' },
  merge: { method: 'squash' },
  // Which work goes to the owner's QA when it merges: any with one of `labels`, or with none of `skipLabels`.
  qa: { labels: [], skipLabels: [] },
  // A tick's limit and hard ceiling, in minutes. AGENT_TICK_MINUTES and AGENT_TICK_CEILING win.
  tick: { minutes: 20, ceiling: 45 },
  // When the sweep frees a lock (minutes) and reports what is overdue (hours).
  sweep: { claimMinutes: 90, readyHours: 4, reviewHours: 4, fixHours: 2, holdHours: 24, heartbeatHours: 8 },
  // A GitHub App per agent (bots.mjs): apps are named <prefix><agent>, in `org`, and a sandbox's
  // variables start with `env` (SWARM_BOT_KEY). With no prefix no bot's review counts as an agent's.
  bots: { prefix: null, org: null, env: 'SWARM' },
  // The work item provider (workitems.mjs). WORK_ITEMS wins.
  tracker: 'linear',
  linear: {
    // Which team holds each repository's work: { "owner/name": "KEY" }. LINEAR_TEAMS wins.
    teams: {},
    // The states that are the `qa` and `needs-human` stages. LINEAR_QA_STATE and LINEAR_NEEDS_HUMAN_STATE win.
    states: { qa: 'Review', needsHuman: 'Needs Human' },
    // The label groups: the locks', the protocol's other labels', and the one that names a repository.
    // The first two default to the namespace: `swarm-agent` and `swarm`.
    groups: { agent: null, protocol: null, repo: 'repo' },
    // The workspace's name in its URLs (linear.app/<workspace>), for the documents.
    workspace: null,
  },
  // A JSON file of what moved work items used to be called, beside this file: { "OLD-12": "NEW-17" }.
  moved: null,
  // A directory of this deployment's own paragraphs for the documents, beside this file (render.mjs).
  notes: 'notes',
};

const REPO = /^[\w.-]+\/[\w.-]+$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `given` over `defaults`, key by key; a key the defaults don't have is a mistake, and named. */
function merge(defaults, given, path, open = []) {
  if (given === undefined) return structuredClone(defaults);
  if (!isObject(given)) throw new Error(`${path || 'the file'} must be an object`);
  const out = structuredClone(defaults);
  for (const [key, value] of Object.entries(given)) {
    const at = path ? `${path}.${key}` : key;
    if (!(key in defaults)) throw new Error(`${at}: no such setting`);
    // Maps the deployment fills in (label names, teams) take any key.
    if (open.includes(at)) out[key] = value;
    else if (isObject(defaults[key])) out[key] = merge(defaults[key], value, at, open);
    else out[key] = value;
  }
  return out;
}

const OPEN = ['labels.names', 'labels.aliases', 'linear.teams'];

function check(cfg) {
  const fail = (msg) => { throw new Error(msg); };
  const string = (v, at, { nullable = false } = {}) => (typeof v === 'string' && v) || (nullable && v === null) || fail(`${at} must be a string`);
  const number = (v, at) => (typeof v === 'number' && v > 0) || fail(`${at} must be a number above 0`);
  const repo = (v, at) => (typeof v === 'string' && REPO.test(v)) || fail(`${at} must be owner/name`);
  string(cfg.name, 'name');
  string(cfg.owner, 'owner', { nullable: true });
  if (cfg.toolsRepo !== null) repo(cfg.toolsRepo, 'toolsRepo');
  if (cfg.designRepo !== null) repo(cfg.designRepo, 'designRepo');
  if (!Array.isArray(cfg.repos)) fail('repos must be a list of owner/name');
  cfg.repos.forEach((r, i) => repo(r, `repos[${i}]`));
  string(cfg.baseBranch, 'baseBranch');
  // A lower-case word and a slash: the Linear groups and the documents are built on it.
  if (!/^[a-z0-9][a-z0-9-]*\/$/.test(cfg.labels.namespace ?? '')) fail('labels.namespace must be lower-case letters, digits and hyphens, then a slash ("swarm/")');
  for (const [key, name] of Object.entries(cfg.labels.names)) {
    if (!(key in LABEL_NAMES)) fail(`labels.names.${key}: no such label (${Object.keys(LABEL_NAMES).join(', ')})`);
    string(name, `labels.names.${key}`);
    if (PREFIXES.includes(key) !== name.endsWith('/')) fail(`labels.names.${key} ${PREFIXES.includes(key) ? 'is a prefix and must end with a slash' : 'must not end with a slash'}`);
  }
  for (const [old, key] of Object.entries(cfg.labels.aliases)) {
    if (!(key in LABEL_NAMES)) fail(`labels.aliases["${old}"]: no such label "${key}" (${Object.keys(LABEL_NAMES).join(', ')})`);
    if (PREFIXES.includes(key) !== old.endsWith('/')) fail(`labels.aliases["${old}"]: ${PREFIXES.includes(key) ? `"${key}" is a prefix, so its old name must end with a slash` : 'only a prefix ends with a slash'}`);
  }
  const full = Object.keys(LABEL_NAMES).map((k) => cfg.labels.namespace + (cfg.labels.names[k] ?? LABEL_NAMES[k]));
  const twice = full.find((n, i) => full.indexOf(n) !== i);
  if (twice) fail(`labels.names gives two labels the name ${twice}`);
  string(cfg.labels.conflict, 'labels.conflict');
  string(cfg.review.status, 'review.status');
  if (!['squash', 'merge', 'rebase'].includes(cfg.merge.method)) fail('merge.method must be squash, merge or rebase');
  for (const list of ['labels', 'skipLabels']) {
    if (!Array.isArray(cfg.qa[list]) || cfg.qa[list].some((l) => typeof l !== 'string')) fail(`qa.${list} must be a list of label names`);
  }
  for (const key of Object.keys(cfg.tick)) number(cfg.tick[key], `tick.${key}`);
  if (cfg.tick.ceiling < cfg.tick.minutes) fail('tick.ceiling must not be below tick.minutes');
  for (const key of Object.keys(cfg.sweep)) number(cfg.sweep[key], `sweep.${key}`);
  if (cfg.bots.prefix !== null && !/^[a-z0-9][a-z0-9-]*-$/.test(cfg.bots.prefix)) fail('bots.prefix must be lower-case letters, digits and hyphens, ending with a hyphen ("acme-")');
  string(cfg.bots.org, 'bots.org', { nullable: true });
  if (!/^[A-Z][A-Z0-9_]*$/.test(cfg.bots.env ?? '')) fail('bots.env must be upper-case letters, digits and underscores ("SWARM")');
  string(cfg.tracker, 'tracker');
  for (const [name, key] of Object.entries(cfg.linear.teams)) {
    repo(name, `linear.teams["${name}"]: its name`);
    string(key, `linear.teams["${name}"]`);
  }
  string(cfg.linear.states.qa, 'linear.states.qa');
  string(cfg.linear.states.needsHuman, 'linear.states.needsHuman');
  string(cfg.linear.groups.agent, 'linear.groups.agent', { nullable: true });
  string(cfg.linear.groups.protocol, 'linear.groups.protocol', { nullable: true });
  string(cfg.linear.groups.repo, 'linear.groups.repo');
  string(cfg.linear.workspace, 'linear.workspace', { nullable: true });
  string(cfg.moved, 'moved', { nullable: true });
  string(cfg.notes, 'notes', { nullable: true });
}

/**
 * The settings in `given` (a parsed file) over the defaults, checked, with
 * what the rest of the code derives from them: `label` (every label's full
 * name, by LABEL_NAMES' keys), `linear.groups` filled in, and `file` and
 * `dir`: the file they came from and its directory, which relative paths
 * (`moved`, `notes`) are read from.
 */
export function resolveConfig(given = {}, { file = null } = {}) {
  let cfg;
  try {
    cfg = merge(DEFAULTS, given, '', OPEN);
    check(cfg);
  } catch (e) {
    throw new Error(`${file ?? 'swarm config'}: ${e.message}`);
  }
  const ns = cfg.labels.namespace;
  const stem = ns.slice(0, -1);
  cfg.label = Object.fromEntries(Object.keys(LABEL_NAMES).map((k) => [k, ns + (cfg.labels.names[k] ?? LABEL_NAMES[k])]));
  cfg.linear.groups.agent ??= `${stem}-agent`;
  cfg.linear.groups.protocol ??= stem;
  cfg.file = file;
  cfg.dir = file ? dirname(file) : null;
  return cfg;
}

/** Where the settings are: SWARM_CONFIG, else swarm.config.json beside the tools; null when there is neither. */
export function configFile(env = process.env, root = toolsRoot) {
  if (env.SWARM_CONFIG) return isAbsolute(env.SWARM_CONFIG) ? env.SWARM_CONFIG : resolve(env.SWARM_CONFIG);
  const beside = join(root, 'swarm.config.json');
  return existsSync(beside) ? beside : null;
}

/** The settings in `file`, or the defaults for null. A file that is named and can't be read is an error, not the defaults. */
export function loadConfig(file) {
  if (!file) return resolveConfig();
  let given;
  try {
    given = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e.code === 'ENOENT' ? 'no such file (SWARM_CONFIG names it)' : e.message}`);
  }
  return resolveConfig(given, { file });
}

/**
 * A path the settings give (`moved`, `notes`), from the directory their file
 * is in; null when it isn't set, or is relative with no file to be relative to.
 */
export function configPath(cfg, name) {
  if (!cfg[name]) return null;
  if (isAbsolute(cfg[name])) return cfg[name];
  return cfg.dir ? join(cfg.dir, cfg[name]) : null;
}

/** This run's settings. */
export const config = loadConfig(configFile());
