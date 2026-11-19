// The work item provider for Linear (workitems.mjs has the interface). A
// team's issues are the work; a repository's are the team's issues it owns:
// those of the first repository listed for the team, unless a `repo/<name>`
// label names another.
//
// Env: LINEAR_TEAMS (`owner/name=KEY` pairs, see DEFAULT_TEAMS), and one way
// in: LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET (an OAuth app with client
// credentials on: the swarm then acts as the app, and mints and caches its
// 30-day token), LINEAR_ACCESS_TOKEN (a token minted elsewhere) or
// LINEAR_API_KEY (a personal key: the swarm acts as that person).
// LINEAR_QA_STATE (default QA) names the state that is the `qa` stage.
// DRY_RUN=true logs writes without making them.

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AGENT_PREFIX, BLOCKED, DESIGN, DESK, FOCUS, GROOM, HANDS_OFF, HOLD, NEEDS_HUMAN, QA, SHAPED } from './rules.mjs';
import { aliasesFor, closedStage, isKey, moved, parsePairs } from './workitems.mjs';

export const API = 'https://api.linear.app/graphql';
export const TOKEN_URL = 'https://api.linear.app/oauth/token';
/** Which team holds each repository's work, as `owner/name=KEY` pairs. */
export const DEFAULT_TEAMS = 'getcouchy/couchy=COU,getcouchy/couchy-agent=COU,getcouchy/agent-runner=COU';
const SCOPES = 'read,write';

// Linear's priorities, by its numbers; 0 is none.
const PRIORITY = ['none', 'urgent', 'high', 'medium', 'low'];
const STAGE_OF = { triage: 'backlog', backlog: 'backlog', unstarted: 'unstarted', started: 'started', completed: 'completed', canceled: 'cancelled', duplicate: 'cancelled' };
const TYPE_OF = { backlog: 'backlog', unstarted: 'unstarted', started: 'started', completed: 'completed', cancelled: 'canceled' };

// Colours for the labels the tools create; anything else gets grey.
const COLORS = [[AGENT_PREFIX, '#5319e7'], [NEEDS_HUMAN, '#d93f0b'], [HOLD, '#fbca04'], [FOCUS, '#b60205'], [HANDS_OFF, '#000000'], [DESK, '#bec2c8'], [BLOCKED, '#e99695'], [QA, '#0e8a16'], [GROOM, '#c5def5'], [DESIGN, '#d4c5f9'], [SHAPED, '#0075ca']];
export const colorOf = (name) => COLORS.find(([p]) => name.startsWith(p))?.[1] ?? '#bec2c8';

const ITEM = `id identifier title description priority url createdAt updatedAt
  state { id name type } labels(first: 50) { nodes { id name } } parent { id } cycle { id isActive }`;
const COMMENT = 'id body createdAt updatedAt';
const RELATED = 'identifier state { type name }';

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
 * (COU); `defaultRepo` the repository its items belong to unless a
 * `repo/<name>` label says otherwise. `auth` is { get, renew? } returning the
 * Authorization header's value. Every list is read once per client: a
 * command runs in seconds.
 */
export function linearClient({
  auth, team, repo, defaultRepo = repo, qaState = 'QA', map = moved(), apiUrl = API,
  dryRun = false, log = console.error, fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(),
}) {
  const owner = repo.split('/')[0];
  let remaining = null;
  let resetAt = 0;

  async function gql(query, variables = {}, { write = false } = {}) {
    if (dryRun && write) {
      log(`[dry run] Linear ${query.trim().split(/[({\s]/).filter(Boolean).slice(0, 2).join(' ')} ${JSON.stringify(variables)}`);
      return null;
    }
    let renewed = false;
    for (let attempt = 1; ; attempt++) {
      if (remaining !== null && remaining <= 1 && resetAt > now()) await sleep(resetAt - now() + 500);
      const res = await fetchImpl(apiUrl, {
        method: 'POST',
        headers: { Authorization: await auth.get(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      const left = res.headers?.get?.('x-ratelimit-requests-remaining');
      const reset = res.headers?.get?.('x-ratelimit-requests-reset');
      if (left != null) remaining = Number(left);
      if (reset != null) resetAt = Number(reset);
      if (res.status === 401 && auth.renew && !renewed) {
        renewed = true;
        await auth.renew();
        continue;
      }
      const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
      const limited = res.status === 429 || body.errors?.some((e) => e.extensions?.code === 'RATELIMITED');
      // A mutation that failed at the gateway may still have landed, so only it isn't retried.
      const again = limited || ([502, 503, 504].includes(res.status) && !write);
      if (again && attempt < 6) {
        const after = Number(res.headers?.get?.('retry-after')) * 1000;
        await sleep(limited ? Math.max(after || resetAt - now(), 1000) + 500 : 2000 * attempt);
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

  let ctx = null;
  let urlKey = null; // the workspace's, for webUrl once the context is read
  const context = () => (ctx ??= (async () => {
    const data = await gql(`query($key: String!) {
      organization { urlKey }
      teams(filter: { key: { eq: $key } }) { nodes { id key states(first: 50) { nodes { id name type position } } } }
    }`, { key: team });
    const found = data.teams.nodes[0];
    if (!found) throw new Error(`Linear has no team ${team}`);
    const labels = await pages(`query($after: String) { issueLabels(first: 250, after: $after) { nodes { id name isGroup team { id } } pageInfo { hasNextPage endCursor } } }`,
      {}, (d) => d.issueLabels);
    // A team's own label wins over a workspace label of the same name.
    const usable = labels.filter((l) => !l.isGroup && (!l.team || l.team.id === found.id))
      .sort((a, b) => Number(Boolean(a.team)) - Number(Boolean(b.team)));
    urlKey = data.organization.urlKey;
    return {
      teamId: found.id,
      states: found.states.nodes,
      byName: new Map(usable.map((l) => [l.name, l])),
    };
  })());

  const repoOf = (names) => {
    const tag = names.find((n) => n.startsWith('repo/'));
    if (!tag) return defaultRepo;
    return tag.includes('/', 5) ? tag.slice(5) : `${owner}/${tag.slice(5)}`;
  };
  const stageOf = (state) => (state?.name === qaState ? 'qa' : STAGE_OF[state?.type] ?? 'backlog');

  /** A Linear issue as the rules read a work item. */
  const shape = (raw) => {
    const names = raw.labels.nodes.map((l) => l.name);
    const stage = stageOf(raw.state);
    const itemRepo = repoOf(names);
    return {
      number: raw.identifier,
      key: raw.identifier,
      id: raw.id,
      title: raw.title,
      body: raw.description ?? '',
      labels: names.map((name) => ({ name })),
      labelIds: raw.labels.nodes.map((l) => l.id),
      stage,
      priority: PRIORITY[raw.priority] ?? 'none',
      state: closedStage(stage) ? 'closed' : 'open',
      repo: itemRepo,
      aliases: aliasesFor(raw.identifier, itemRepo, map),
      parent: raw.parent?.id ?? null,
      sprint: Boolean(raw.cycle?.isActive),
      created_at: raw.createdAt,
      updated_at: raw.updatedAt,
      html_url: raw.url,
    };
  };

  let cache = null;
  const all = async () => {
    const { teamId } = await context();
    return (cache ??= (await pages(`query($team: ID!, $after: String) {
      issues(first: 100, after: $after, filter: { team: { id: { eq: $team } } }) { nodes { ${ITEM} } pageInfo { hasNextPage endCursor } }
    }`, { team: teamId }, (d) => d.issues)).map(shape));
  };
  const last = new Map(); // key -> the item as this client last read or wrote it
  const remember = (item) => {
    if (cache) cache = [...cache.filter((i) => i.id !== item.id), item];
    last.set(item.key, item);
    return item;
  };
  const get = async (key) => {
    try {
      return remember(shape((await gql(`query($id: String!) { issue(id: $id) { ${ITEM} } }`, { id: key })).issue));
    } catch (e) {
      if (e.errors?.some((x) => /not found|Entity not found/i.test(x.message))) return null;
      throw e;
    }
  };
  const known = async (key) => (await all()).find((i) => i.key === key) ?? last.get(key) ?? get(key);
  const need = async (key) => {
    const item = await known(key);
    if (!item) throw new Error(`Linear has no issue ${key}`);
    return item;
  };

  async function labelId(name) {
    const c = await context();
    const have = c.byName.get(name);
    if (have) return have.id;
    let made;
    try {
      made = (await gql(`mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id name } } }`,
        { input: { name, color: colorOf(name) } }, { write: true }))?.issueLabelCreate.issueLabel;
    } catch (e) {
      // Another agent made it a moment ago.
      made = (await pages(`query($name: String!, $after: String) { issueLabels(first: 50, after: $after, filter: { name: { eq: $name } }) { nodes { id name } pageInfo { hasNextPage endCursor } } }`,
        { name }, (d) => d.issueLabels))[0];
      if (!made) throw e;
    }
    if (!made) return null; // dry run
    c.byName.set(made.name, made);
    return made.id;
  }

  async function update(item, input) {
    const raw = (await gql(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { issue { ${ITEM} } } }`,
      { id: item.id, input }, { write: true }))?.issueUpdate.issue;
    return raw ? remember(shape(raw)) : item;
  }

  // `qa` is the QA state, or Done in a team that has none; otherwise the first state of the type, by Linear's order.
  const stateFor = (c, stage) => (stage === 'qa' && c.states.find((s) => s.name === qaState))
    || c.states.filter((s) => s.type === TYPE_OF[stage === 'qa' ? 'completed' : stage] && s.name !== qaState).sort((a, b) => a.position - b.position)[0];

  const commentIds = new Set();
  const shapeComment = (raw) => {
    commentIds.add(raw.id);
    return { id: raw.id, body: raw.body ?? '', created_at: raw.createdAt, updated_at: raw.updatedAt };
  };

  const related = new Map(); // key -> its relations, asked once per client
  const relations = (key) => {
    if (!related.has(key)) {
      related.set(key, need(key).then(async (item) => {
        const { issue } = await gql(`query($id: String!) { issue(id: $id) {
          relations(first: 100) { nodes { type relatedIssue { ${RELATED} } } }
          inverseRelations(first: 100) { nodes { type issue { ${RELATED} } } }
        } }`, { id: item.id });
        const open = (i) => !closedStage(stageOf(i.state));
        return {
          blocking: issue.relations.nodes.filter((r) => r.type === 'blocks').map((r) => ({ key: r.relatedIssue.identifier, open: open(r.relatedIssue) })),
          blockedBy: issue.inverseRelations.nodes.filter((r) => r.type === 'blocks').map((r) => ({ key: r.issue.identifier, open: open(r.issue) })),
        };
      }));
    }
    return related.get(key);
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
    seen: (key) => last.get(key) ?? cache?.find((i) => i.key === key) ?? null,
    addLabel: async (key, name) => {
      const item = await get(key);
      if (!item || item.labels.some((l) => l.name === name)) return;
      const id = await labelId(name);
      if (!id) return;
      // One label added, not the whole list written back: a label another agent adds at the same time survives.
      const raw = (await gql(`mutation($id: String!, $label: String!) { issueAddLabel(id: $id, labelId: $label) { issue { ${ITEM} } } }`,
        { id: item.id, label: id }, { write: true }))?.issueAddLabel.issue;
      if (raw) remember(shape(raw));
    },
    removeLabel: async (key, name) => {
      const item = await get(key);
      const at = item?.labels.findIndex((l) => l.name === name) ?? -1;
      if (at < 0) return;
      const raw = (await gql(`mutation($id: String!, $label: String!) { issueRemoveLabel(id: $id, labelId: $label) { issue { ${ITEM} } } }`,
        { id: item.id, label: item.labelIds[at] }, { write: true }))?.issueRemoveLabel.issue;
      if (raw) remember(shape(raw));
    },
    setStage: async (key, stage) => {
      const item = await need(key);
      const to = stateFor(await context(), stage);
      if (!to) throw new Error(`Linear team ${team} has no ${stage} state`);
      const now = to.name === qaState ? 'qa' : STAGE_OF[to.type];
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
        nodes { createdAt addedLabels { name } removedLabels { name } } pageInfo { hasNextPage endCursor } } } }`, { id: item.id }, (d) => d.issue.history);
      return history.flatMap((h) => [
        ...(h.addedLabels ?? []).map((l) => ({ event: 'labeled', label: { name: l.name }, created_at: h.createdAt })),
        ...(h.removedLabels ?? []).map((l) => ({ event: 'unlabeled', label: { name: l.name }, created_at: h.createdAt })),
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
      related.delete(key);
    },
    addLink: async (key, url, title) => {
      const item = await need(key);
      if ((await attachmentsOf(item)).some((a) => a.url === url)) return false;
      await gql(`mutation($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }`,
        { input: { issueId: item.id, url, title } }, { write: true });
      return true;
    },
    links: async (key) => (await attachmentsOf(await need(key))).filter((a) => !isUpload(a.url)).map((a) => ({ url: a.url, title: a.title })),
    create: async ({ title, body, labels = [], parent = null, priority = null }) => {
      const c = await context();
      const ids = [];
      for (const name of labels) ids.push(await labelId(name));
      const input = {
        teamId: c.teamId, title, description: body, labelIds: ids.filter(Boolean), stateId: stateFor(c, 'backlog')?.id,
        ...(parent ? { parentId: (await need(parent)).id } : {}),
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
    webUrl: (key) => last.get(key)?.html_url ?? cache?.find((i) => i.key === key)?.html_url ?? `https://linear.app/${urlKey ?? 'couchy'}/issue/${key}`,
    rateLimitRemaining: () => remaining,
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

/** The Linear provider for a repository's work, from the environment; exits 2 when it can't be made. */
export function linearFromEnv(repo, env = process.env) {
  const teams = parsePairs(env.LINEAR_TEAMS || DEFAULT_TEAMS);
  const team = teams.get(repo);
  const auth = authFromEnv(env);
  if (!auth || !team) {
    console.error(!auth
      ? 'LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET (or LINEAR_ACCESS_TOKEN, or LINEAR_API_KEY) required: the swarm\'s work items are in Linear (PROTOCOL.md, "Where the work is").'
      : `LINEAR_TEAMS names no Linear team for ${repo}.`);
    process.exit(2);
  }
  return linearClient({
    auth,
    team,
    repo,
    defaultRepo: [...teams].find(([, key]) => key === team)[0],
    qaState: env.LINEAR_QA_STATE || 'QA',
    dryRun: env.DRY_RUN === 'true',
  });
}
