// The work item provider for Linear (workitems.mjs has the interface). A
// team's issues are the work; a repository's are the team's issues it owns:
// those of the first repository listed for the team, unless a label in the
// `repo` group names another.
//
// Linear keeps the swarm's labels in label groups, and the rules read them
// under the names they have on GitHub (see protocolName): `claude-1` in the
// `swarm-agent` group is the lock `swarm/agent/claude-1`, `needs-human` in the
// `swarm` group is `swarm/needs-human`, `api` in `repo` is `repo/api`. (Those
// are the default names: the namespace and the groups are the deployment's,
// config.mjs.) A single-select group takes one label per issue, so a
// second agent's lock is refused rather than doubled (LabelGroupTaken).
//
// Env: LINEAR_TEAMS (`owner/name=KEY` pairs; else the settings' `linear.teams`), and one way
// in: LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET (an OAuth app with client
// credentials on: the swarm then acts as the app, and mints and caches its
// 30-day token), LINEAR_ACCESS_TOKEN (a token minted elsewhere) or
// LINEAR_API_KEY (a personal key: the swarm acts as that person).
// LINEAR_QA_STATE names the state that is the `qa` stage, and
// LINEAR_NEEDS_HUMAN_STATE the one that is `needs-human` (else the settings'
// `linear.states`: Review and Needs Human unless they say otherwise).
// DRY_RUN=true logs writes without making them.

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from './config.mjs';
import { AGENT_PREFIX, BLOCKED, DESIGN, DESK, FOCUS, TASK_BREAKDOWN, HANDS_OFF, HOLD, NEEDS_HUMAN, NEEDS_PREFIX, NS, QA, TECH_DESIGN } from './rules.mjs';
import { LabelGroupTaken, aliasesFor, closedStage, isKey, moved, parsePairs } from './workitems.mjs';

export const API = 'https://api.linear.app/graphql';
export const TOKEN_URL = 'https://api.linear.app/oauth/token';
/** Which team holds each repository's work, as `owner/name=KEY` pairs: the settings' `linear.teams`. */
export const DEFAULT_TEAMS = Object.entries(config.linear.teams).map(([repo, key]) => `${repo}=${key}`).join(',');
const SCOPES = 'read,write';

// Linear's priorities, by its numbers; 0 is none.
const PRIORITY = ['none', 'urgent', 'high', 'medium', 'low'];
const STAGE_OF = { triage: 'backlog', backlog: 'backlog', unstarted: 'unstarted', started: 'started', completed: 'completed', canceled: 'cancelled', duplicate: 'cancelled' };
const TYPE_OF = { backlog: 'backlog', unstarted: 'unstarted', started: 'started', completed: 'completed', cancelled: 'canceled' };

// Colours for the labels the tools create; anything else gets grey.
const COLORS = [[AGENT_PREFIX, '#5319e7'], [NEEDS_HUMAN, '#d93f0b'], [HOLD, '#fbca04'], [FOCUS, '#b60205'], [HANDS_OFF, '#000000'], [DESK, '#bec2c8'], [BLOCKED, '#e99695'], [QA, '#0e8a16'], [TASK_BREAKDOWN, '#c5def5'], [DESIGN, '#d4c5f9'], [TECH_DESIGN, '#1d76db']];
export const colorOf = (name) => COLORS.find(([p]) => name.startsWith(p))?.[1] ?? '#bec2c8';

// The groups the protocol's labels live in, in Linear.
export const AGENT_GROUP = config.linear.groups.agent;
export const SWARM_GROUP = config.linear.groups.protocol;
// The group whose labels say which repository an item belongs to: `repo/api`.
const REPO_PREFIX = `${config.linear.groups.repo}/`;
// Children of the swarm group that are labels of their own, not `swarm/needs/<thing>`.
const SWARM_OWN = new Set([NEEDS_HUMAN].map((n) => n.slice(NS.length)));

/**
 * The name the rules read for a Linear label, { name, parent: { name } }: a
 * child of `swarm-agent` is a lock (`swarm/agent/<name>`); `needs-<thing>` in
 * `swarm` is `swarm/needs/<thing>`, and its other children `swarm/<name>`; a
 * child of any other group is `<group>/<name>` (a child already named
 * `platform/ios` stays that). A label in no group keeps its name. The group
 * and prefix names here are the defaults.
 */
export function protocolName({ name, parent }) {
  const group = parent?.name;
  if (!group) return name;
  if (group === AGENT_GROUP) return AGENT_PREFIX + name;
  if (group === SWARM_GROUP) return name.startsWith('needs-') && !SWARM_OWN.has(name) ? NEEDS_PREFIX + name.slice(6) : NS + name;
  return name.startsWith(`${group}/`) ? name : `${group}/${name}`;
}

/** Where protocolName's `name` goes in Linear: { group, child }, or null for a label in no group. */
export function linearPlace(name) {
  if (name.startsWith(AGENT_PREFIX)) return { group: AGENT_GROUP, child: name.slice(AGENT_PREFIX.length) };
  if (name.startsWith(NEEDS_PREFIX)) return { group: SWARM_GROUP, child: `needs-${name.slice(NEEDS_PREFIX.length)}` };
  if (name.startsWith(NS)) return { group: SWARM_GROUP, child: name.slice(NS.length) };
  const at = name.indexOf('/');
  return at > 0 ? { group: name.slice(0, at), child: name.slice(at + 1) } : null;
}

const groupTaken = (e) => e.errors?.find((x) => /not exclusive/i.test(x.message ?? ''));

const ITEM = `id identifier title description priority url createdAt updatedAt
  state { id name type } labels(first: 20) { nodes { id name retiredAt parent { name } } } parent { id } cycle { id isActive } project { id }`;
const COMMENT = 'id body createdAt updatedAt';

/**
 * A client-credentials token for an OAuth app, cached in `file` (0600, in a
 * 0700 directory of the user's own) until a day before it expires, so the
 * ticks and the sweep share one rather than minting a token a command.
 */
export function appToken({ clientId, clientSecret, file, fetchImpl = fetch, now = () => Date.now() }) {
  let token = null;
  const read = () => {
    try {
      const dir = statSync(dirname(file));
      if (dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0) return null;
      const t = JSON.parse(readFileSync(file, 'utf8'));
      return t.clientId === clientId && t.expiresAt - 86_400_000 > now() ? t : null;
    } catch {
      return null;
    }
  };
  const mint = async () => {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: SCOPES }).toString(),
    });
    if (!res.ok) throw new Error(`Linear token: ${res.status} ${await res.text()}`);
    const body = await res.json();
    const t = { clientId, accessToken: body.access_token, expiresAt: now() + body.expires_in * 1000 };
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify(t), { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch {
      // no cache: the next command mints its own
    }
    return t;
  };
  return {
    get: async () => (token ??= read() ?? await mint()).accessToken,
    /** After a 401: the cached token was revoked or the secret rotated. */
    renew: async () => (token = await mint()).accessToken,
  };
}

/**
 * A Linear client for one repository's work items. `team` is the team key
 * (ABC); `defaultRepo` the repository its items belong to unless a label
 * in the `repo` group says otherwise. `auth` is { get, renew? } returning the
 * Authorization header's value. Every list is read once per client: a
 * command runs in seconds.
 */
/** What the clients of one team read once between them: a command has one for each repository. */
export const sharedReads = () => ({ ctx: null, urlKey: null, list: null, loading: null, relations: null, reading: null, others: new Map(), last: new Map(), requests: null, complexity: null, resetAt: 0 });

// A refused request is asked again, for this long in all: the budget refills as it
// goes, and an agent's command is killed at two minutes, with nothing to show.
const PATIENCE = 60_000;
const ASK_AGAIN = 15_000;
// The types of state whose work is finished, Review and Needs Human aside.
const FINISHED = ['completed', 'canceled', 'duplicate'];

export function linearClient({
  auth, team, repo, defaultRepo = repo, qaState = config.linear.states.qa, humanState = config.linear.states.needsHuman, map = moved(), apiUrl = API,
  dryRun = false, log = console.error, fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), shared = sharedReads(),
}) {
  const owner = repo.split('/')[0];
  const left = () => `${shared.complexity ?? 'an unknown part'} of its complexity budget and ${shared.requests ?? 'an unknown number of'} requests are left`;
  const spent = () => Object.assign(new Error(`Linear's budget is spent (${left()}): run this again in a few minutes. Nothing is wrong with what you asked.`), { status: 429, errors: [] });

  async function gql(query, variables = {}, { write = false } = {}) {
    if (dryRun && write) {
      log(`[dry run] Linear ${query.trim().split(/[({\s]/).filter(Boolean).slice(0, 2).join(' ')} ${JSON.stringify(variables)}`);
      return null;
    }
    let renewed = false;
    let waited = 0;
    const wait = async (ms, why) => {
      if (waited + ms > PATIENCE) throw spent();
      waited += ms;
      if (why) log(`${why}: ${left()}. Asking again in ${Math.ceil(ms / 1000)} s.`);
      await sleep(ms);
    };
    for (let attempt = 1; ; attempt++) {
      if (shared.requests !== null && shared.requests <= 1 && shared.resetAt > now()) await wait(shared.resetAt - now() + 500);
      const res = await fetchImpl(apiUrl, {
        method: 'POST',
        headers: { Authorization: await auth.get(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      const requests = res.headers?.get?.('x-ratelimit-requests-remaining');
      const reset = res.headers?.get?.('x-ratelimit-requests-reset');
      const budget = res.headers?.get?.('x-ratelimit-complexity-remaining');
      if (requests != null) shared.requests = Number(requests);
      if (budget != null) shared.complexity = Number(budget);
      if (reset != null) shared.resetAt = Number(reset);
      if (res.status === 401 && auth.renew && !renewed) {
        renewed = true;
        await auth.renew();
        continue;
      }
      const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
      const limited = res.status === 429 || body.errors?.some((e) => e.extensions?.code === 'RATELIMITED');
      if (limited) {
        await wait(Number(res.headers?.get?.('retry-after')) * 1000 || ASK_AGAIN, 'Linear refused a request');
        continue;
      }
      // A mutation that failed at the gateway may still have landed, so it isn't retried.
      if ([502, 503, 504].includes(res.status) && !write && attempt < 6) {
        await sleep(2000 * attempt);
        continue;
      }
      if (!res.ok || body.errors?.length) {
        const err = new Error(`Linear: ${res.status} ${body.errors?.map((e) => e.message).join('; ') ?? ''}`.trim());
        err.status = res.status;
        err.errors = body.errors ?? [];
        throw err;
      }
      return body.data;
    }
  }

  /** Every node of a connection, page by page; `at` finds the connection in the result. */
  async function pages(query, variables, at) {
    const out = [];
    for (let after = null; ;) {
      const conn = at(await gql(query, { ...variables, after }));
      out.push(...conn.nodes);
      if (!conn.pageInfo.hasNextPage) return out;
      after = conn.pageInfo.endCursor;
    }
  }

  const context = () => (shared.ctx ??= (async () => {
    const data = await gql(`query($key: String!) {
      organization { urlKey }
      teams(first: 1, filter: { key: { eq: $key } }) { nodes { id key states(first: 50) { nodes { id name type position } } } }
    }`, { key: team });
    const found = data.teams.nodes[0];
    if (!found) throw new Error(`Linear has no team ${team}`);
    shared.urlKey = data.organization.urlKey; // the workspace's, for webUrl
    return { teamId: found.id, states: found.states.nodes, ...await labelsOf(found.id) };
  })().catch((e) => {
    shared.ctx = null;
    throw e;
  }));

  /**
   * The labels this team can apply, by the name the rules read, and the
   * groups by name. A retired label can't be applied, so it isn't here. A
   * label in a group wins over one of the same name in none (`swarm/blocked`
   * from before the groups), and a team's own over a workspace label.
   */
  async function labelsOf(teamId) {
    const labels = await pages(`query($after: String) { issueLabels(first: 250, after: $after) {
      nodes { id name isGroup retiredAt parent { id name } team { id } } pageInfo { hasNextPage endCursor } } }`, {}, (d) => d.issueLabels);
    const usable = labels.filter((l) => !l.retiredAt && (!l.team || l.team.id === teamId));
    const rank = (l) => Number(Boolean(l.parent)) * 2 + Number(Boolean(l.team));
    const byName = new Map();
    for (const l of usable.filter((x) => !x.isGroup).sort((a, b) => rank(a) - rank(b))) byName.set(protocolName(l), l);
    const groups = new Map(usable.filter((l) => l.isGroup).sort((a, b) => rank(a) - rank(b)).map((l) => [l.name, l]));
    return { byName, groups };
  }

  const repoOf = (names) => {
    const tag = names.find((n) => n.startsWith(REPO_PREFIX));
    if (!tag) return defaultRepo;
    const name = tag.slice(REPO_PREFIX.length);
    return name.includes('/') ? name : `${owner}/${name}`;
  };
  const stageOf = (state) => (state?.name === qaState ? 'qa' : state?.name === humanState ? 'needs-human' : STAGE_OF[state?.type] ?? 'backlog');

  // Work in Review has merged; a technical design there has not, so it still blocks.
  const closed = (stage, names) => closedStage(stage) && !(stage === 'qa' && names.includes(TECH_DESIGN));

  /** A Linear issue as the rules read a work item. */
  const shape = (raw) => {
    const names = raw.labels.nodes.map(protocolName);
    const stage = stageOf(raw.state);
    const itemRepo = repoOf(names);
    return {
      number: raw.identifier,
      key: raw.identifier,
      id: raw.id,
      title: raw.title,
      body: raw.description ?? '',
      // A label retired in Linear stays on the items that had it; `retired` says it can't be given to another.
      labels: raw.labels.nodes.map((l, i) => ({ name: names[i], ...(l.retiredAt ? { retired: true } : {}) })),
      labelIds: raw.labels.nodes.map((l) => l.id),
      stage,
      priority: PRIORITY[raw.priority] ?? 'none',
      state: closed(stage, names) ? 'closed' : 'open',
      repo: itemRepo,
      aliases: aliasesFor(raw.identifier, itemRepo, map),
      parent: raw.parent?.id ?? null,
      project: raw.project?.id ?? null,
      cycle: raw.cycle?.id ?? null,
      sprint: Boolean(raw.cycle?.isActive),
      created_at: raw.createdAt,
      updated_at: raw.updatedAt,
      html_url: raw.url,
    };
  };

  /**
   * The team's work that isn't finished, the parts of it that are, and finished
   * work still labelled blocked, which the sweep takes the label off. The rest
   * is most of the team, every command would pay for it, and nothing needs it
   * here: a relation says whether its other end is open, and `get` reads any
   * item by its key.
   */
  const unfinished = [{ state: { type: { nin: FINISHED } } }, { state: { name: { in: [qaState, humanState] } } }];
  const all = async () => {
    if (!shared.list) {
      shared.loading ??= context().then(async ({ teamId }) => {
        shared.list = (await pages(`query($filter: IssueFilter!, $after: String) {
          issues(first: 100, after: $after, filter: $filter) { nodes { ${ITEM} } pageInfo { hasNextPage endCursor } }
        }`, { filter: { team: { id: { eq: teamId } }, or: [...unfinished, ...unfinished.map((parent) => ({ parent: { null: false, ...parent } })), { labels: { name: { in: [BLOCKED, BLOCKED.slice(NS.length)] } } }] } }, (d) => d.issues)).map(shape);
      }).finally(() => { shared.loading = null; });
      await shared.loading;
    }
    return shared.list;
  };
  const { last } = shared; // key -> the item as it was last read or written
  const remember = (item) => {
    if (shared.list) shared.list = [...shared.list.filter((i) => i.id !== item.id), item];
    last.set(item.key, item);
    return item;
  };
  const fetchItem = async (key) => {
    try {
      return shape((await gql(`query($id: String!) { issue(id: $id) { ${ITEM} } }`, { id: key })).issue);
    } catch (e) {
      if (e.errors?.some((x) => /not found|Entity not found/i.test(x.message))) return null;
      throw e;
    }
  };
  const get = async (key) => {
    const item = await fetchItem(key);
    return item && remember(item);
  };
  const known = async (key) => (await all()).find((i) => i.key === key) ?? last.get(key) ?? get(key);
  const need = async (key) => {
    const item = await known(key);
    if (!item) throw new Error(`Linear has no issue ${key}`);
    return item;
  };

  /** The id of the label the rules call `name`, made (in its group, when Linear has that group) if it is new. */
  async function labelId(name) {
    const c = await context();
    const have = c.byName.get(name);
    if (have) return have.id;
    const place = linearPlace(name);
    const group = place && c.groups.get(place.group);
    const input = group ? { name: place.child, parentId: group.id, color: colorOf(name) } : { name, color: colorOf(name) };
    let made;
    try {
      made = (await gql(`mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id name } } }`,
        { input }, { write: true }))?.issueLabelCreate.issueLabel;
    } catch (e) {
      // Another agent made it a moment ago.
      Object.assign(c, await labelsOf(c.teamId));
      made = c.byName.get(name);
      if (!made) throw e;
    }
    if (!made) return null; // dry run
    c.byName.set(name, made);
    return made.id;
  }

  async function update(item, input) {
    const raw = (await gql(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { issue { ${ITEM} } } }`,
      { id: item.id, input }, { write: true }))?.issueUpdate.issue;
    return raw ? remember(shape(raw)) : item;
  }

  // `qa` is the Review state, or Done in a team that has none; `needs-human` the Needs Human state, with no fallback;
  // otherwise the first state of the type, by Linear's order, that is neither.
  const stateFor = (c, stage) => {
    if (stage === 'needs-human') return c.states.find((s) => s.name === humanState);
    return (stage === 'qa' && c.states.find((s) => s.name === qaState))
      || c.states.filter((s) => s.type === TYPE_OF[stage === 'qa' ? 'completed' : stage] && ![qaState, humanState].includes(s.name))
        .sort((a, b) => a.position - b.position)[0];
  };

  const commentIds = new Set();
  const shapeComment = (raw) => {
    commentIds.add(raw.id);
    return { id: raw.id, body: raw.body ?? '', created_at: raw.createdAt, updated_at: raw.updatedAt };
  };

  // Every blocking relation there is, read once: `next` and the sweep ask about every
  // open item, and an item's own relations cost far more than its share of these.
  const links = async () => {
    if (!shared.relations) {
      shared.reading ??= pages(`query($after: String) { issueRelations(first: 250, after: $after) {
        nodes { type issue { identifier } relatedIssue { identifier } } pageInfo { hasNextPage endCursor } } }`, {}, (d) => d.issueRelations)
        .then((all) => { shared.relations = all.filter((r) => r.type === 'blocks').map((r) => ({ from: r.issue.identifier, to: r.relatedIssue.identifier })); })
        .finally(() => { shared.reading = null; });
      await shared.reading;
    }
    return shared.relations;
  };
  // What isn't in the list is finished, or another team's.
  const isOpen = async (key) => {
    const listed = (await all()).find((i) => i.key === key);
    if (listed || key.startsWith(`${team}-`)) return listed?.state === 'open';
    if (!shared.others.has(key)) shared.others.set(key, fetchItem(key));
    return (await shared.others.get(key))?.state === 'open';
  };
  const relations = async (key) => {
    const named = (keys) => Promise.all(keys.map(async (k) => ({ key: k, open: await isOpen(k) })));
    const every = await links();
    return {
      blocking: await named(every.filter((r) => r.from === key).map((r) => r.to)),
      blockedBy: await named(every.filter((r) => r.to === key).map((r) => r.from)),
    };
  };

  const attachmentsOf = async (item) => (await gql(`query($id: String!) { issue(id: $id) { attachments(first: 100) { nodes { id url title subtitle metadata } } } }`,
    { id: item.id })).issue.attachments.nodes;
  const isUpload = (url) => /^https:\/\/uploads\.linear\.app\//.test(url);

  return {
    name: 'linear',
    repo,
    team,
    dryRun,
    owns: (key) => isKey(key) && key.startsWith(`${team}-`),
    all,
    get,
    seen: (key) => last.get(key) ?? shared.list?.find((i) => i.key === key) ?? null,
    addLabel: async (key, name) => {
      const item = await get(key);
      if (!item || item.labels.some((l) => l.name === name)) return;
      const id = await labelId(name);
      if (!id) return;
      // One label added, not the whole list written back: a label another agent adds at the same time survives.
      let raw;
      try {
        raw = (await gql(`mutation($id: String!, $label: String!) { issueAddLabel(id: $id, labelId: $label) { issue { ${ITEM} } } }`,
          { id: item.id, label: id }, { write: true }))?.issueAddLabel.issue;
      } catch (e) {
        const taken = groupTaken(e);
        if (taken) throw new LabelGroupTaken(key, name, taken.extensions?.userPresentableMessage ?? taken.message);
        throw e;
      }
      if (raw) remember(shape(raw));
    },
    /** Every label on it the rules call `name`: one in a group, and one of the same name in none. */
    removeLabel: async (key, name) => {
      let item = await get(key);
      for (let at; item && (at = item.labels.findIndex((l) => l.name === name)) >= 0;) {
        const raw = (await gql(`mutation($id: String!, $label: String!) { issueRemoveLabel(id: $id, labelId: $label) { issue { ${ITEM} } } }`,
          { id: item.id, label: item.labelIds[at] }, { write: true }))?.issueRemoveLabel.issue;
        if (!raw) return; // dry run
        item = remember(shape(raw));
      }
    },
    setStage: async (key, stage) => {
      const item = await need(key);
      const to = stateFor(await context(), stage);
      if (!to) throw new Error(`Linear team ${team} has no ${stage} state`);
      const now = stageOf(to);
      if (item.stage !== now) await update(item, { stateId: to.id });
      return now;
    },
    comments: async (key) => {
      const item = await need(key);
      return (await pages(`query($id: String!, $after: String) { issue(id: $id) { comments(first: 100, after: $after) { nodes { ${COMMENT} } pageInfo { hasNextPage endCursor } } } }`,
        { id: item.id }, (d) => d.issue.comments)).map(shapeComment).sort((a, b) => a.created_at.localeCompare(b.created_at));
    },
    comment: async (key, md) => {
      const item = await need(key);
      const raw = (await gql(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { comment { ${COMMENT} } } }`,
        { input: { issueId: item.id, body: md } }, { write: true }))?.commentCreate.comment;
      return raw ? shapeComment(raw) : null;
    },
    ownsComment: (id) => commentIds.has(id),
    editComment: async (id, md) => {
      await gql(`mutation($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }`,
        { id, input: { body: md } }, { write: true });
    },
    labelEvents: async (key) => {
      const item = await need(key);
      const history = await pages(`query($id: String!, $after: String) { issue(id: $id) { history(first: 100, after: $after) {
        nodes { createdAt addedLabels { name parent { name } } removedLabels { name parent { name } } } pageInfo { hasNextPage endCursor } } } }`, { id: item.id }, (d) => d.issue.history);
      return history.flatMap((h) => [
        ...(h.addedLabels ?? []).map((l) => ({ event: 'labeled', label: { name: protocolName(l) }, created_at: h.createdAt })),
        ...(h.removedLabels ?? []).map((l) => ({ event: 'unlabeled', label: { name: protocolName(l) }, created_at: h.createdAt })),
      ]).sort((a, b) => a.created_at.localeCompare(b.created_at));
    },
    relations,
    relate: async (key, kind, keys) => {
      const item = await need(key);
      for (const k of keys) {
        const other = await need(k);
        const input = kind === 'blocked_by' ? { issueId: other.id, relatedIssueId: item.id, type: 'blocks' }
          : kind === 'blocking' ? { issueId: item.id, relatedIssueId: other.id, type: 'blocks' }
            : { issueId: item.id, relatedIssueId: other.id, type: 'related' };
        await gql(`mutation($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }`, { input }, { write: true });
      }
      shared.relations = null;
    },
    addLink: async (key, url, title) => {
      const item = await need(key);
      if ((await attachmentsOf(item)).some((a) => a.url === url)) return false;
      await gql(`mutation($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }`,
        { input: { issueId: item.id, url, title } }, { write: true });
      return true;
    },
    links: async (key) => (await attachmentsOf(await need(key))).filter((a) => !isUpload(a.url)).map((a) => ({ url: a.url, title: a.title })),
    create: async ({ title, body, labels = [], parent = null, priority = null, project = null, cycle = null }) => {
      const c = await context();
      // An item with no `repo` label is defaultRepo's, so one made for another
      // repository (the desk its sweep makes, work its tick files) carries it.
      const own = repo !== defaultRepo && !labels.some((n) => n.startsWith(REPO_PREFIX)) ? [`${REPO_PREFIX}${repo.split('/')[1]}`] : [];
      const ids = [];
      for (const name of [...labels, ...own]) ids.push(await labelId(name));
      const input = {
        teamId: c.teamId, title, description: body, labelIds: ids.filter(Boolean), stateId: stateFor(c, 'backlog')?.id,
        ...(parent ? { parentId: (await need(parent)).id } : {}),
        ...(project ? { projectId: project } : {}),
        ...(cycle ? { cycleId: cycle } : {}),
        ...(priority && PRIORITY.includes(priority) ? { priority: PRIORITY.indexOf(priority) } : {}),
      };
      const raw = (await gql(`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { ${ITEM} } } }`,
        { input }, { write: true }))?.issueCreate.issue;
      return raw ? remember(shape(raw)) : null;
    },
    update: async (key, { body, title }) => {
      const item = await need(key);
      await update(item, { ...(body != null ? { description: body } : {}), ...(title != null ? { title } : {}) });
    },
    attachments: async (key) => (await attachmentsOf(await need(key))).filter((a) => isUpload(a.url))
      .map((a) => ({ id: a.id, name: a.title, type: a.metadata?.contentType ?? '', size: a.metadata?.size ?? null })),
    /** Uploads a file to Linear's storage (a signed PUT), then attaches it to the issue. */
    attach: async (key, { name, type, bytes }) => {
      const item = await need(key);
      const up = (await gql(`mutation($name: String!, $type: String!, $size: Int!) {
        fileUpload(filename: $name, contentType: $type, size: $size) { uploadFile { uploadUrl assetUrl headers { key value } } }
      }`, { name, type, size: bytes.length }, { write: true }))?.fileUpload.uploadFile;
      if (!up) return null; // dry run
      const headers = { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000' };
      for (const h of up.headers) headers[h.key] = h.value;
      const put = await fetchImpl(up.uploadUrl, { method: 'PUT', headers, body: bytes });
      if (!put.ok) throw new Error(`upload of ${name}: ${put.status} ${await put.text()}`);
      const made = (await gql(`mutation($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { attachment { id } } }`,
        { input: { issueId: item.id, url: up.assetUrl, title: name, metadata: { contentType: type, size: bytes.length } } }, { write: true }))?.attachmentCreate.attachment;
      return made ? { id: made.id, name } : null;
    },
    attachmentUrl: async (key, id) => (await attachmentsOf(await need(key))).find((a) => a.id === id)?.url ?? null,
    /** Fetch a file a description or an attachment points at; Linear's own uploads need this client's credentials. */
    download: async (url) => {
      const res = await fetchImpl(url, { headers: isUpload(url) ? { Authorization: await auth.get() } : {}, redirect: 'follow' });
      if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
      return { type: res.headers?.get?.('content-type') ?? '', bytes: Buffer.from(await res.arrayBuffer()) };
    },
    /** An item's page: its own URL when this client has read it, else built from the workspace's URL key. */
    webUrl: (key) => last.get(key)?.html_url ?? shared.list?.find((i) => i.key === key)?.html_url ?? `https://linear.app/${[shared.urlKey ?? config.linear.workspace, 'issue', key].filter(Boolean).join('/')}`,
    rateLimitRemaining: () => shared.requests,
    complexityRemaining: () => shared.complexity,
    shared,
  };
}

/** Where the app's token is cached: $LINEAR_TOKEN_FILE, else under $XDG_CACHE_HOME or ~/.cache. */
export const tokenFile = (env = process.env) => env.LINEAR_TOKEN_FILE
  || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'swarm', 'linear-token.json');

/** The Authorization a client sends, from the environment; null when nothing is set. */
export function authFromEnv(env = process.env, fetchImpl = fetch) {
  if (env.LINEAR_CLIENT_ID && env.LINEAR_CLIENT_SECRET) {
    const t = appToken({ clientId: env.LINEAR_CLIENT_ID, clientSecret: env.LINEAR_CLIENT_SECRET, file: tokenFile(env), fetchImpl });
    return { get: async () => `Bearer ${await t.get()}`, renew: async () => `Bearer ${await t.renew()}` };
  }
  if (env.LINEAR_ACCESS_TOKEN) return { get: async () => `Bearer ${env.LINEAR_ACCESS_TOKEN}` };
  if (env.LINEAR_API_KEY) return { get: async () => env.LINEAR_API_KEY };
  return null;
}

const sharedOf = new WeakMap(); // an environment -> its teams' shared reads

/** The Linear provider for a repository's work, from the environment; exits 2 when it can't be made. */
export function linearFromEnv(repo, env = process.env) {
  const teams = parsePairs(env.LINEAR_TEAMS || DEFAULT_TEAMS);
  const team = teams.get(repo);
  const auth = authFromEnv(env);
  if (!auth || !team) {
    console.error(!auth
      ? 'LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET (or LINEAR_ACCESS_TOKEN, or LINEAR_API_KEY) required: the swarm\'s work items are in Linear (PROTOCOL.md, "Where the work is").'
      : `No Linear team is named for ${repo}: add it to LINEAR_TEAMS (owner/name=KEY pairs) or to \`linear.teams\` in swarm.config.json.`);
    process.exit(2);
  }
  if (!sharedOf.has(env)) sharedOf.set(env, new Map());
  const reads = sharedOf.get(env);
  if (!reads.has(team)) reads.set(team, sharedReads());
  return linearClient({
    shared: reads.get(team),
    auth,
    team,
    repo,
    defaultRepo: [...teams].find(([, key]) => key === team)[0],
    qaState: env.LINEAR_QA_STATE || config.linear.states.qa,
    humanState: env.LINEAR_NEEDS_HUMAN_STATE || config.linear.states.needsHuman,
    dryRun: env.DRY_RUN === 'true',
  });
}
