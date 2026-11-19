// Work items behind one interface. The work lives in a tracker (Linear today,
// linear.mjs); the pull requests on GitHub (github.mjs). A provider speaks one
// tracker's API and hands back plain work items. Everything the protocol
// decides on top of that (which items are open, in focus, blocked, what a
// moved item used to be called) is here, once, for every provider. tracker()
// joins a provider with GitHub behind the issue-shaped client the rules read.
//
// A new tracker is a module exporting a function that returns an object with
// every method of PROVIDER_METHODS, registered in PROVIDERS below; the shared
// contract test (workitems.test.mjs, providerContract) holds it to this file.

import { readFileSync } from 'node:fs';
import { FOCUS, bodyBlockers, labelNames, oldName } from './rules.mjs';

/**
 * @typedef {'backlog' | 'unstarted' | 'started' | 'qa' | 'completed' | 'cancelled'} Stage
 *   Where a work item is. `qa` is its own stage whatever the tracker files it
 *   under: its PR has merged, so no agent takes it, and it blocks nothing.
 *
 * @typedef {'urgent' | 'high' | 'medium' | 'low' | 'none'} Priority
 *
 * @typedef {object} WorkItem A work item, shaped like the GitHub issue the rules read.
 * @property {string} number    its key, as for `key`: that is how a ref tells a work item from a PR number
 * @property {string} key       `COU-12`
 * @property {string} id        the tracker's own id
 * @property {string} title
 * @property {string} body      the description, as Markdown
 * @property {{ name: string }[]} labels
 * @property {Stage} stage
 * @property {'open' | 'closed'} state   closed in `completed`, `cancelled` and `qa`
 * @property {Priority} priority
 * @property {string} repo      the repository it belongs to (`owner/name`)
 * @property {(string | number)[]} aliases  what PRs and descriptions may still call it (moved.json)
 * @property {string | null} parent  the parent item's `id`
 * @property {boolean} sprint   whether it is in the team's current cycle
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string} html_url
 *
 * @typedef {object} Comment
 * @property {string} id
 * @property {string} body      Markdown; the protocol's `<!-- … -->` markers survive in it
 * @property {string} created_at
 * @property {string} updated_at
 *
 * @typedef {object} Related   An item on the other end of a relation.
 * @property {string} key
 * @property {boolean} open
 *
 * @typedef {object} WorkItemProvider
 * @property {string} name        `linear`
 * @property {string} repo        the repository this client serves
 * @property {boolean} dryRun     writes are logged, not made
 * @property {(key: string) => boolean} owns   whether a key is one of this tracker's
 * @property {() => Promise<WorkItem[]>} all   every open-or-closed item the tracker holds for any repository, read once
 * @property {(key: string) => Promise<WorkItem | null>} get   the item as the tracker has it now, never cached: claims are decided on it
 * @property {(key: string) => WorkItem | null} seen   the item as this client last had it, without asking
 * @property {(key: string, name: string) => Promise<void>} addLabel      no-op when present
 * @property {(key: string, name: string) => Promise<void>} removeLabel   no-op when absent
 * @property {(key: string, stage: Stage) => Promise<Stage>} setStage     returns where it is now (`completed` for `qa` without a QA state)
 * @property {(key: string) => Promise<Comment[]>} comments   oldest first
 * @property {(key: string, md: string) => Promise<Comment | null>} comment
 * @property {(id: string) => boolean} ownsComment
 * @property {(id: string, md: string) => Promise<void>} editComment
 * @property {(key: string) => Promise<{ event: 'labeled' | 'unlabeled', label: { name: string }, created_at: string }[]>} labelEvents
 * @property {(key: string) => Promise<{ blockedBy: Related[], blocking: Related[] }>} relations
 * @property {(key: string, kind: 'blocked_by' | 'blocking' | 'relates_to', keys: string[]) => Promise<void>} relate
 * @property {(key: string, url: string, title: string) => Promise<boolean>} addLink   false when already linked
 * @property {(key: string) => Promise<{ url: string, title: string }[]>} links   what is linked to it (its PRs), uploads aside
 * @property {(item: { title: string, body: string, labels?: string[], parent?: string | null, priority?: Priority | null }) => Promise<WorkItem | null>} create   always in Backlog
 * @property {(key: string, change: { title?: string, body?: string }) => Promise<void>} update
 * @property {(key: string) => Promise<{ id: string, name: string, type: string, size: number | null }[]>} attachments   uploaded files only
 * @property {(key: string, file: { name: string, type: string, bytes: Uint8Array }) => Promise<{ id: string, name: string } | null>} attach
 * @property {(key: string, id: string) => Promise<string>} attachmentUrl
 * @property {(url: string) => Promise<{ type: string, bytes: Buffer }>} download   with this client's credentials for the tracker's own URLs
 * @property {(key: string) => string} webUrl
 * @property {() => number | null} rateLimitRemaining
 */

/** Every method and field a provider has; providerContract checks each. */
export const PROVIDER_METHODS = [
  'owns', 'all', 'get', 'seen', 'addLabel', 'removeLabel', 'setStage', 'comments', 'comment', 'ownsComment',
  'editComment', 'labelEvents', 'relations', 'relate', 'addLink', 'links', 'create', 'update', 'attachments', 'attach',
  'attachmentUrl', 'download', 'webUrl', 'rateLimitRemaining',
];

/** Throws unless `p` has every method of the interface. */
export function assertProvider(p) {
  const missing = PROVIDER_METHODS.filter((m) => typeof p?.[m] !== 'function');
  for (const f of ['name', 'repo']) if (typeof p?.[f] !== 'string') missing.push(f);
  if (missing.length) throw new Error(`work item provider ${p?.name ?? '?'} lacks ${missing.join(', ')}`);
  return p;
}

const KEY = /^([A-Z][A-Z0-9]*)-(\d+)$/;
/** Whether `ref` names a work item (`COU-12`, or a moved item's old key) rather than a pull request number. */
export const isKey = (ref) => typeof ref === 'string' && KEY.test(ref);

/** `owner/name=VALUE` pairs, comma-separated, as a Map; the first pair for a value is its default repository. */
export function parsePairs(text) {
  const map = new Map();
  for (const pair of (text ?? '').split(',')) {
    const [repo, value] = pair.split('=').map((s) => s.trim());
    if (repo && value) map.set(repo, value);
  }
  return map;
}

export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
export const STAGES = ['backlog', 'unstarted', 'started', 'qa', 'completed', 'cancelled'];
export const closedStage = (stage) => ['completed', 'cancelled', 'qa'].includes(stage);

/**
 * What items moved between trackers used to be called: `{ "COUCHYUX-12":
 * "COU-17", "getcouchy/couchy#1680": "COU-17" }`. A PR body or description
 * that still says the old name reaches the item. Read once from moved.json.
 */
let movedMap = null;
export function moved(file = new URL('./moved.json', import.meta.url)) {
  if (movedMap && file instanceof URL && file.href.endsWith('/moved.json')) return movedMap;
  let map = {};
  try {
    map = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return (movedMap = map);
}

/** The names a moved item answers to besides its key, for refsOf: old keys, `owner/name#n`, and `n` in its own repository. */
export function aliasesFor(key, repo, map) {
  const out = [];
  for (const [old, now] of Object.entries(map)) {
    if (now !== key) continue;
    out.push(old);
    const gh = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(old);
    if (gh && gh[1] === repo) out.push(Number(gh[2]));
  }
  return out;
}

/** A key as the tracker knows it now: an old one (moved.json) becomes its new one. */
export const currentKey = (ref, map = moved()) => (isKey(ref) && map[ref]) || ref;

/**
 * The issue-shaped client the rules read, from a work item provider: the
 * filters, focus, blockers and lookups every tracker shares.
 */
export function workItems(provider, { map = moved() } = {}) {
  assertProvider(provider);
  const { repo } = provider;
  const mine = async () => (await provider.all()).filter((i) => i.repo === repo);
  const key = (ref) => currentKey(ref, map);

  /**
   * The open item a reference names, from every repository's items: a key
   * (old or new), or a GitHub issue an item was copied from (`#1680` in this
   * repository, `getcouchy/couchy-agent#5`). null when none matches.
   */
  async function find(ref) {
    const list = await provider.all();
    if (ref.key) return list.find((i) => i.key === key(ref.key)) ?? null;
    const name = `${ref.repo ?? repo}#${ref.number}`;
    const now = map[name];
    return list.find((i) => (now ? i.key === now : i.aliases.includes(name))) ?? null;
  }

  return {
    repo,
    provider,
    dryRun: provider.dryRun,
    owns: (ref) => isKey(ref) && provider.owns(key(ref)),
    /**
     * Open items of this repository carrying every one of `labels`, oldest
     * first. Every item in the current cycle counts as carrying `swarm/focus`:
     * the sprint is what the owner put first.
     */
    openIssues: async (labels = []) => (await mine())
      .filter((i) => i.state === 'open')
      .filter((i) => labels.every((l) => labelNames(i).includes(l) || (l === FOCUS && i.sprint)))
      .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    issue: (ref) => provider.get(key(ref)),
    seen: (ref) => provider.seen(key(ref)),
    /** This repository's items carrying a label, in any state. */
    labelledItems: async (name) => (await mine()).filter((i) => labelNames(i).includes(name)),
    /** This repository's items waiting in QA, longest first. */
    inQA: async () => (await mine()).filter((i) => i.stage === 'qa')
      .sort((a, b) => (a.updated_at ?? '').localeCompare(b.updated_at ?? '')),
    /** Children of an item (the tracker's parent link), three levels down at most. */
    subIssues: async function subIssues(ref, depth = 3) {
      const list = await provider.all();
      const parent = list.find((i) => i.key === key(ref));
      const out = [];
      for (const child of list.filter((i) => parent && i.parent === parent.id && i.repo === repo)) {
        out.push(child.key);
        if (depth > 1) out.push(...await subIssues(child.key, depth - 1));
      }
      return out;
    },
    addLabel: (ref, name) => provider.addLabel(key(ref), name),
    /** Removed under its name or the one it had before the `swarm/` prefix. */
    removeLabel: async (ref, name) => {
      for (const n of [...new Set([name, oldName(name)])].filter(Boolean)) await provider.removeLabel(key(ref), n);
    },
    setStage: (ref, stage) => provider.setStage(key(ref), stage),
    comments: (ref) => provider.comments(key(ref)),
    comment: (ref, md) => provider.comment(key(ref), md),
    ownsComment: (id) => provider.ownsComment(id),
    editComment: (id, md) => provider.editComment(id, md),
    events: (ref) => provider.labelEvents(key(ref)),
    /**
     * What still blocks an item, as keys: the open items its "blocked by"
     * relations name, and those its description names after "Blocked by". A
     * GitHub issue the description names that no item came from was closed
     * before the move, so it blocks nothing.
     */
    blockers: async (item) => {
      const open = new Set();
      for (const ref of bodyBlockers(item.body)) {
        const other = await find(ref);
        if (other && other.state === 'open' && other.id !== item.id) open.add(other.key);
      }
      for (const r of (await provider.relations(item.key)).blockedBy) if (r.open) open.add(r.key);
      return [...open];
    },
    /** The open items its "blocking" relations say wait on this one. Descriptions' side: rules.mjs, blockGraph. */
    blocking: async (item) => (await provider.relations(item.key)).blocking.filter((r) => r.open).map((r) => r.key),
    relate: (ref, kind, keys) => provider.relate(key(ref), kind, keys.map(key)),
    find: (ref) => find(typeof ref === 'string' ? { key: ref } : { number: ref }),
    addLink: (ref, url, title) => provider.addLink(key(ref), url, title),
    links: (ref) => provider.links(key(ref)),
    createIssue: (title, body, labels = [], { parent = null, priority = null } = {}) =>
      provider.create({ title, body, labels, parent: parent && key(parent), priority }),
    editIssue: (ref, change) => provider.update(key(ref), change),
    attachments: (ref) => provider.attachments(key(ref)),
    attach: (ref, file) => provider.attach(key(ref), file),
    attachmentUrl: (ref, id) => provider.attachmentUrl(key(ref), id),
    download: (url) => provider.download(url),
    webUrl: (ref) => provider.webUrl(key(ref)),
    rateLimitRemaining: () => provider.rateLimitRemaining(),
  };
}

/**
 * One client for a repository's issues and pull requests: work items go to
 * the provider, pull requests (and their labels, comments and events) to
 * GitHub, chosen by the reference: a key or a number.
 */
export function tracker(gh, provider, { map = moved() } = {}) {
  const items = workItems(provider, { map });
  const to = (ref) => (isKey(ref) ? items : gh);
  return {
    ...gh,
    items,
    openIssues: items.openIssues,
    subIssues: items.subIssues,
    blockers: items.blockers,
    blocking: items.blocking,
    inQA: items.inQA,
    labelledItems: items.labelledItems,
    createIssue: items.createIssue,
    relate: items.relate,
    attachments: items.attachments,
    attach: items.attach,
    download: items.download,
    attachmentUrl: items.attachmentUrl,
    setStage: items.setStage,
    addLink: items.addLink,
    links: items.links,
    findIssue: items.find,
    seen: items.seen,
    issue: (ref) => to(ref).issue(ref),
    addLabel: (ref, name) => to(ref).addLabel(ref, name),
    removeLabel: (ref, name) => to(ref).removeLabel(ref, name),
    comments: (ref) => to(ref).comments(ref),
    comment: (ref, body) => to(ref).comment(ref, body),
    editComment: (id, body) => (items.ownsComment(id) ? items.editComment(id, body) : gh.editComment(id, body)),
    events: (ref) => to(ref).events(ref),
    editIssue: (ref, patch) => to(ref).editIssue(ref, patch),
    // GitHub's issues are not the swarm's; only its pull requests' labels are.
    labelled: async (label) => (await gh.labelled(label)).filter((i) => i.pull_request),
    workItemsRateLimitRemaining: items.rateLimitRemaining,
  };
}

/**
 * The trackers a provider can be, by the name WORK_ITEMS picks (default
 * linear). Each takes (repo, env) and returns a provider, or exits 2 with
 * what is missing.
 */
export const PROVIDERS = {
  linear: async (repo, env) => (await import('./linear.mjs')).linearFromEnv(repo, env),
};

/** The work item provider for a repository, from the environment. */
export async function providerFromEnv(repo, env = process.env) {
  const name = env.WORK_ITEMS || 'linear';
  const make = PROVIDERS[name];
  if (!make) {
    console.error(`WORK_ITEMS=${name}: no such work item provider (${Object.keys(PROVIDERS).join(', ')}).`);
    process.exit(2);
  }
  return assertProvider(await make(repo, env));
}
