// Work items in Plane, shaped like the GitHub issues the rules read, so the
// tick and the sweep treat a work item as they treated an issue. Pull requests
// stay on GitHub (github.mjs); tracker() joins the two behind one client.
//
// A work item's `number` is its key (`COUCHYUX-12`), a pull request's is its
// number: that is how tracker() tells them apart.
//
// Env: PLANE_BASE_URL (the API's origin), PLANE_API_TOKEN, PLANE_WORKSPACE
// (slug, default couchy), PLANE_WEB_URL (the origin people open, default
// PLANE_BASE_URL), PLANE_PROJECTS (see DEFAULT_PROJECTS), PLANE_QA_STATE (the
// state work waits in for the owner's QA, default QA). DRY_RUN=true logs
// writes without making them.

import { AGENT_PREFIX, BLOCKED, DESIGN, DESK, FOCUS, GROOM, NEEDS_HUMAN, HOLD, HANDS_OFF, QA, SHAPED, bodyBlockers, labelNames, oldName } from './rules.mjs';

const KEY = /^([A-Z][A-Z0-9]*)-(\d+)$/;
/** Whether `ref` names a Plane work item (`COUCHYUX-12`) rather than a pull request number. */
export const isKey = (ref) => typeof ref === 'string' && KEY.test(ref);

/**
 * Which Plane project holds each repository's work, as `owner/name=IDENTIFIER`
 * pairs. A work item belongs to the first repository listed for its project,
 * unless a `repo/<name>` label or the GitHub issue it was copied from names
 * another.
 */
export const DEFAULT_PROJECTS = 'getcouchy/couchy=COUCHYUX,getcouchy/couchy-agent=COUCHYUX,getcouchy/agent-runner=RUNNER';

export function parseProjects(text) {
  const map = new Map();
  for (const pair of (text ?? '').split(',')) {
    const [repo, id] = pair.split('=').map((s) => s.trim());
    if (repo && id) map.set(repo, id);
  }
  return map;
}

const ENTITIES = { nbsp: ' ', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", amp: '&' };

const decode = (s) => s.replace(/&(nbsp|lt|gt|quot|#39|apos|amp);/g, (_, e) => ENTITIES[e]);
const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag)?.[1] ?? null;
const untag = (html) => html.replace(/<[^>]+>/g, '');

// Images, code, bold and links as Markdown; other tags are left for htmlToText.
// A link around nothing but an image keeps the image.
const inlineMd = (html) => html
  .replace(/<a\b[^>]*>\s*(<img\b[^>]*>)\s*<\/a>/gi, '$1')
  .replace(/<img\b[^>]*>/gi, (tag) => (attr(tag, 'src') ? `![${attr(tag, 'alt') || 'image'}](${attr(tag, 'src')})` : ''))
  .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => `\`${untag(c)}\``)
  .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, t, c) => (c.trim() ? `**${c}**` : c))
  .replace(/<a\b[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => `[${untag(text)}](${href})`);

function tableMd(inner) {
  const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map((c) => untag(inlineMd(c[1])).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()));
  if (!rows.length) return '';
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return `\n${[line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n')}\n`;
}

/**
 * A description as the little Markdown mdToHtml writes back: headings, `-` and
 * `1.` lists, tables, fenced code, `code`, **bold**, links and images
 * (`![alt](url)`), one block per paragraph. The rules read issue bodies from
 * it, and an agent rewriting a description keeps what it doesn't change.
 */
export function htmlToText(html) {
  const md = inlineMd((html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => `\n\`\`\`\n${untag(c).replace(/^\n+|\n+$/g, '')}\n\`\`\`\n`)
    .replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, t) => tableMd(t))
    .replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, l) => l.replace(/<li\b[^>]*>/gi, '\n1. '))
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<hr\b[^>]*>/gi, '\n---\n'));
  return decode(md
    .replace(/<\/?(br|p|div|li|h[1-6]|tr|pre|blockquote|ul|ol|table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/^((?:- |1\. |#{1,6} ))[ \t]*\n+[ \t]*/gm, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}(?=(?:- |1\. ))/g, (m, i, all) => (/(^|\n)(?:- |1\. )[^\n]*$/.test(all.slice(0, i)) ? '\n' : m))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '<img src="$2" alt="$1">')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

/**
 * Markdown as the HTML Plane stores: paragraphs, `-` and `1.` lists, `#`
 * headings, tables, fenced code, `---`, `code`, **bold**, links and images. A
 * line that is only an HTML comment passes through untouched: the markers the
 * tools read back (`<!-- agent-heartbeat: codex -->`) live in those.
 */
export function mdToHtml(md) {
  const out = [];
  let para = [];
  let list = null;
  let table = null;
  let code = null;
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
    if (table) {
      const [head, ...rows] = table;
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    }
    table = null;
  };
  for (const line of (md ?? '').split('\n')) {
    if (code) {
      if (/^```/.test(line)) { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; } else code.push(line);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^\s*-\s+(.*)$/.exec(line);
    const oli = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (/^```/.test(line)) {
      flush(); close(); code = [];
    } else if (/^\s*<!--[\s\S]*-->\s*$/.test(line)) {
      flush(); close(); out.push(line.trim());
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      if (list) close();
      if (/^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line)) continue;
      (table ??= []).push(cells(line));
    } else if (h) {
      flush(); close(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush(); close(); out.push('<hr>');
    } else if (li || oli) {
      flush();
      const kind = li ? 'ul' : 'ol';
      if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((li ?? oli)[1])}</li>`);
    } else if (!line.trim()) {
      flush(); close();
    } else {
      close(); para.push(line);
    }
  }
  if (code) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  flush(); close();
  return out.join('');
}

// Colours for the labels the tools create; anything else gets grey.
const COLORS = [[AGENT_PREFIX, '#5319e7'], [NEEDS_HUMAN, '#d93f0b'], [HOLD, '#fbca04'], [FOCUS, '#b60205'], [HANDS_OFF, '#000000'], [DESK, '#ededed'], [BLOCKED, '#e99695'], [QA, '#0e8a16'], [GROOM, '#c5def5'], [DESIGN, '#d4c5f9'], [SHAPED, '#0075ca']];
const colorOf = (name) => COLORS.find(([p]) => name.startsWith(p))?.[1] ?? '#ededed';
const GITHUB_REF = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

/**
 * A client for one repository's work items. `project` is the Plane project
 * identifier (COUCHYUX); `defaultRepo` the repository its items belong to
 * unless they say otherwise. Every list is read once per client: a command
 * runs in seconds, and Plane limits the requests a minute per key.
 */
export function planeClient({
  baseUrl, webUrl = baseUrl, apiKey, workspace, project, repo, defaultRepo = repo, qaState = 'QA',
  dryRun = false, log = console.error, fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(),
}) {
  const origin = baseUrl.replace(/\/+$/, '');
  const web = webUrl.replace(/\/+$/, '');
  const owner = repo.split('/')[0];
  let remaining = null;
  let resetAt = 0;

  async function api(method, path, body) {
    if (dryRun && method !== 'GET') {
      log(`[dry run] Plane ${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''}`);
      return null;
    }
    for (let attempt = 1; ; attempt++) {
      // The key's minute is shared with every other tick and the sweep: wait it out rather than fail.
      if (remaining !== null && remaining <= 1 && resetAt > now()) await sleep(resetAt - now() + 500);
      const res = await fetchImpl(`${origin}/api/v1/workspaces/${workspace}/${path}`, {
        method,
        headers: { 'X-API-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const left = res.headers?.get?.('x-ratelimit-remaining');
      const reset = res.headers?.get?.('x-ratelimit-reset');
      if (left != null) remaining = Number(left);
      if (reset != null) resetAt = Number(reset) * 1000;
      // A POST that failed at the gateway may still have landed, so only it isn't retried.
      const again = res.status === 429 || ([502, 503, 504].includes(res.status) && method !== 'POST');
      if (again && attempt < 6) {
        await sleep(res.status === 429 ? Math.max(resetAt - now(), 1000) + 500 : 2000 * attempt);
        continue;
      }
      if (!res.ok) {
        const err = new Error(`Plane ${method} ${path}: ${res.status} ${await res.text()}`);
        err.status = res.status;
        throw err;
      }
      return res.status === 204 ? null : res.json();
    }
  }

  async function all(path) {
    const out = [];
    for (let cursor = null; ;) {
      const sep = path.includes('?') ? '&' : '?';
      const page = await api('GET', `${path}${sep}per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (Array.isArray(page)) return page;
      out.push(...(page?.results ?? []));
      if (!page?.next_page_results) return out;
      cursor = page.next_cursor;
    }
  }

  let ctx = null;
  const context = () => (ctx ??= (async () => {
    const found = (await all('projects/')).find((p) => p.identifier === project);
    if (!found) throw new Error(`Plane workspace ${workspace} has no project ${project}`);
    const base = `projects/${found.id}`;
    const [states, labels] = await Promise.all([all(`${base}/states/`), all(`${base}/labels/`)]);
    return {
      base,
      states,
      groupOf: new Map(states.map((s) => [s.id, s.group])),
      nameOf: new Map(states.map((s) => [s.id, s.name])),
      byId: new Map(labels.map((l) => [l.id, l])),
      byName: new Map(labels.map((l) => [l.name, l])),
    };
  })());

  const repoOf = (raw, names) => {
    const tag = names.find((n) => n.startsWith('repo/'));
    if (tag) return tag.includes('/', 5) ? tag.slice(5) : `${owner}/${tag.slice(5)}`;
    const copied = raw.external_source === 'github' && GITHUB_REF.exec(raw.external_id ?? '');
    return copied ? copied[1] : defaultRepo;
  };

  /** A Plane work item as the rules read an issue. */
  const shape = (raw, c) => {
    const labelIds = (raw.labels ?? []).map((l) => (typeof l === 'string' ? l : l.id));
    const names = labelIds.map((id) => c.byId.get(id)?.name).filter(Boolean);
    // An item in the QA state is in its own stage, `qa`, whatever group the
    // state is in: its PR has merged, so no agent takes it, and it blocks nothing.
    const stateId = typeof raw.state === 'string' ? raw.state : raw.state?.id;
    const stage = c.nameOf.get(stateId) === qaState ? 'qa' : c.groupOf.get(stateId) ?? 'backlog';
    const key = `${project}-${raw.sequence_id}`;
    const itemRepo = repoOf(raw, names);
    const copied = raw.external_source === 'github' ? GITHUB_REF.exec(raw.external_id ?? '') : null;
    return {
      number: key,
      key,
      id: raw.id,
      title: raw.name,
      body: htmlToText(raw.description_html),
      html: raw.description_html ?? '',
      labels: names.map((name) => ({ name })),
      labelIds,
      stage,
      priority: raw.priority ?? 'none',
      state: ['completed', 'cancelled', 'qa'].includes(stage) ? 'closed' : 'open',
      repo: itemRepo,
      // What a pull request or an issue body copied from GitHub may still call it: `#1680` in its own repository.
      aliases: copied ? [copied[0], ...(copied[1] === itemRepo ? [Number(copied[2])] : [])] : [],
      parent: raw.parent ?? null,
      created_at: raw.created_at,
      updated_at: raw.updated_at,
      html_url: `${web}/${workspace}/browse/${key}/`,
    };
  };

  let cache = null;
  const items = async () => {
    const c = await context();
    return (cache ??= (await all(`${c.base}/issues/`)).map((raw) => shape(raw, c)));
  };
  const last = new Map(); // key -> the item as this client last read or wrote it
  const remember = (item) => {
    if (cache) cache = [...cache.filter((i) => i.id !== item.id), item];
    last.set(item.key, item);
    return item;
  };
  /** The item as Plane has it now, never from the cache: claims are decided on it. */
  const fresh = async (key) => remember(shape(await api('GET', `work-items/${key}/`), await context()));
  const known = async (key) => (await items()).find((i) => i.key === key) ?? fresh(key);

  const related = new Map(); // work item id -> its relations, asked once per client
  const relations = (item) => {
    if (!related.has(item.id)) related.set(item.id, context().then((c) => api('GET', `${c.base}/work-items/${item.id}/relations/`)));
    return related.get(item.id);
  };
  const relationIds = (rel, kind) => (rel?.[kind] ?? []).map((r) => (typeof r === 'string' ? r : r.id ?? r.issue_id));

  let cycle = null;
  /** Ids of the work items in the project's current cycle: the sprint. */
  const sprint = () => (cycle ??= (async () => {
    const c = await context();
    const current = await api('GET', `${c.base}/cycles/?cycle_view=current`);
    const ids = new Set();
    for (const cy of Array.isArray(current) ? current : current?.results ?? []) {
      for (const i of await all(`${c.base}/cycles/${cy.id}/cycle-issues/`)) ids.add(i.issue ?? i.id);
    }
    return ids;
  })());

  async function labelId(name) {
    const c = await context();
    const have = c.byName.get(name);
    if (have) return have.id;
    const group = name.includes('/') ? c.byName.get(name.split('/')[0]) : null;
    let made;
    try {
      made = await api('POST', `${c.base}/labels/`, { name, color: colorOf(name), ...(group ? { parent: group.id } : {}) });
    } catch (e) {
      if (e.status !== 400 && e.status !== 409) throw e;
      // Another agent made it a moment ago.
      made = (await all(`${c.base}/labels/`)).find((l) => l.name === name);
      if (!made) throw e;
    }
    if (!made) return null; // dry run
    c.byId.set(made.id, made);
    c.byName.set(made.name, made);
    return made.id;
  }

  async function patch(item, body) {
    const c = await context();
    const raw = await api('PATCH', `${c.base}/work-items/${item.id}/`, body);
    return raw ? remember(shape(raw, c)) : item;
  }

  // `qa` is the QA state, or Done in a project that has none.
  const stateFor = (c, group) => (group === 'qa' && c.states.find((s) => s.name === qaState)) || c.states.filter((s) => s.group === (group === 'qa' ? 'completed' : group) && s.name !== qaState)
    .sort((a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)) || (a.sequence ?? 0) - (b.sequence ?? 0))[0];

  const commentOf = new Map(); // comment id -> work item id, for editComment
  const shapeComment = (itemId, raw) => {
    commentOf.set(raw.id, itemId);
    return { id: raw.id, body: raw.comment_html ?? '', created_at: raw.created_at, updated_at: raw.updated_at };
  };

  /**
   * The open work item a reference names, from the whole project: a key, or
   * a GitHub issue it was copied from (`#1680` in this repository,
   * `getcouchy/couchy-agent#5`). null when none matches.
   */
  async function find(ref) {
    const list = await items();
    if (ref.key) return list.find((i) => i.key === ref.key) ?? null;
    const name = `${ref.repo ?? repo}#${ref.number}`;
    return list.find((i) => i.aliases.includes(name)) ?? null;
  }

  return {
    repo,
    project,
    dryRun,
    rateLimitRemaining: () => remaining,
    webUrl: (key) => `${web}/${workspace}/browse/${key}/`,
    /**
     * Open work items of this repository carrying every one of `labels`,
     * oldest first. Every item in the current cycle counts as carrying
     * `swarm/focus`: the sprint is what the owner put first.
     */
    openIssues: async (labels = []) => {
      const inSprint = labels.includes(FOCUS) ? await sprint() : new Set();
      return (await items())
        .filter((i) => i.state === 'open' && i.repo === repo)
        .filter((i) => labels.every((l) => labelNames(i).includes(l) || (l === FOCUS && inSprint.has(i.id))))
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
    },
    issue: fresh,
    /** The work item as this client last had it, without asking Plane; null if it never did. */
    seen: (key) => last.get(key) ?? cache?.find((i) => i.key === key) ?? null,
    /** This repository's work items carrying a label, in any state. */
    labelledItems: async (name) => (await items()).filter((i) => i.repo === repo && labelNames(i).includes(name)),
    /** This repository's work items waiting in QA, longest first. */
    inQA: async () => (await items()).filter((i) => i.stage === 'qa' && i.repo === repo)
      .sort((a, b) => (a.updated_at ?? '').localeCompare(b.updated_at ?? '')),
    /** Children of a work item (Plane's parent link), three levels down at most. */
    subIssues: async function subIssues(key, depth = 3) {
      const list = await items();
      const parent = list.find((i) => i.key === key);
      const out = [];
      for (const child of list.filter((i) => parent && i.parent === parent.id && i.repo === repo)) {
        out.push(child.key);
        if (depth > 1) out.push(...await subIssues(child.key, depth - 1));
      }
      return out;
    },
    addLabel: async (key, name) => {
      const item = await fresh(key);
      const id = await labelId(name);
      if (!id || item.labelIds.includes(id)) return;
      // Plane takes the whole list, so it is read just before: a label another
      // agent added a moment ago survives unless both writes cross.
      await patch(item, { labels: [...item.labelIds, id] });
    },
    removeLabel: async (key, name) => {
      const item = await fresh(key);
      const c = await context();
      const drop = new Set([name, oldName(name)].map((n) => n && c.byName.get(n)?.id).filter(Boolean));
      if (!item.labelIds.some((id) => drop.has(id))) return;
      await patch(item, { labels: item.labelIds.filter((id) => !drop.has(id)) });
    },
    /**
     * Moves a work item to the first state of a group (unstarted, started,
     * completed), or to QA (`qa`). Returns the stage it is in now: `completed`
     * for `qa` in a project with no QA state.
     */
    setStage: async (key, group) => {
      const item = await known(key);
      const to = stateFor(await context(), group);
      const stage = to.name === qaState ? 'qa' : to.group;
      if (item.stage !== stage) await patch(item, { state: to.id });
      return stage;
    },
    comments: async (key) => {
      const item = await known(key);
      const c = await context();
      return (await all(`${c.base}/work-items/${item.id}/comments/`)).map((raw) => shapeComment(item.id, raw));
    },
    comment: async (key, md) => {
      const item = await known(key);
      const c = await context();
      const raw = await api('POST', `${c.base}/work-items/${item.id}/comments/`, { comment_html: mdToHtml(md) });
      return raw ? shapeComment(item.id, raw) : null;
    },
    ownsComment: (id) => commentOf.has(id),
    editComment: async (id, md) => {
      const c = await context();
      await api('PATCH', `${c.base}/work-items/${commentOf.get(id)}/comments/${id}/`, { comment_html: mdToHtml(md) });
    },
    /** Label changes, as GitHub's issue events: { event: 'labeled' | 'unlabeled', label: { name }, created_at }. */
    events: async (key) => {
      const item = await known(key);
      const c = await context();
      return (await all(`${c.base}/work-items/${item.id}/activities/`))
        .filter((a) => a.field === 'labels')
        .map((a) => (a.new_value
          ? { event: 'labeled', label: { name: a.new_value }, created_at: a.created_at }
          : { event: 'unlabeled', label: { name: a.old_value }, created_at: a.created_at }));
    },
    /**
     * What still blocks a work item, as keys: the open items Plane's
     * "blocked by" relations name, and those its description names after
     * "Blocked by". A GitHub issue the description names that has no work
     * item was closed before the move, so it blocks nothing; a relation to an
     * item outside this project counts as open.
     */
    blockers: async (item) => {
      const list = await items();
      const open = new Set();
      for (const ref of bodyBlockers(item.body)) {
        const other = await find(ref);
        if (other && other.state === 'open' && other.id !== item.id) open.add(other.key);
      }
      for (const id of relationIds(await relations(item), 'blocked_by')) {
        const other = list.find((i) => i.id === id);
        if (!other) open.add(`${id} (in another project)`);
        else if (other.state === 'open') open.add(other.key);
      }
      return [...open];
    },
    /**
     * The open work items Plane's "blocking" relations say wait on this one,
     * by key. The description's side is read from the other items' "Blocked
     * by" lines (rules.mjs, blockGraph).
     */
    blocking: async (item) => {
      const list = await items();
      return relationIds(await relations(item), 'blocking')
        .map((id) => list.find((i) => i.id === id))
        .filter((other) => other && other.state === 'open')
        .map((other) => other.key);
    },
    /** The open work item a pull request or description refers to (`COUCHYUX-12`, `#1680`), or null. */
    find: (ref) => find(typeof ref === 'string' ? { key: ref } : { number: ref }),
    addLink: async (key, url, title) => {
      const item = await known(key);
      const c = await context();
      const links = await all(`${c.base}/work-items/${item.id}/links/`);
      if (links.some((l) => l.url === url)) return false;
      await api('POST', `${c.base}/work-items/${item.id}/links/`, { url, title });
      return true;
    },
    /** A new work item, always in Backlog; `parent` is a key. */
    createIssue: async (title, md, labels = [], { parent = null, priority = null } = {}) => {
      const c = await context();
      const ids = [];
      for (const name of labels) ids.push(await labelId(name));
      const raw = await api('POST', `${c.base}/work-items/`, {
        name: title, description_html: mdToHtml(md), labels: ids.filter(Boolean), state: stateFor(c, 'backlog')?.id,
        ...(parent ? { parent: (await known(parent)).id } : {}), ...(priority ? { priority } : {}),
      });
      return raw ? remember(shape(raw, c)) : null;
    },
    /** Add Plane relations of `kind` (`blocked_by`, `blocking`, `relates_to`) from one work item to others, by key. */
    relate: async (key, kind, keys) => {
      const c = await context();
      const item = await known(key);
      const ids = [];
      for (const k of keys) ids.push((await known(k)).id);
      await api('POST', `${c.base}/work-items/${item.id}/relations/`, { relation_type: kind, issues: ids });
      related.delete(item.id);
    },
    /** A work item's uploaded attachments: [{ id, name, type, size }]. */
    attachments: async (key) => {
      const c = await context();
      const item = await known(key);
      const list = await api('GET', `${c.base}/work-items/${item.id}/attachments/`);
      return (Array.isArray(list) ? list : list?.results ?? []).filter((a) => a.is_uploaded !== false)
        .map((a) => ({ id: a.id, name: a.attributes?.name ?? a.name, type: a.attributes?.type ?? a.type, size: a.attributes?.size ?? a.size }));
    },
    /**
     * Upload a file to a work item's attachments: Plane hands out a presigned
     * POST to its storage, then is told the upload landed.
     */
    attach: async (key, { name, type, bytes }) => {
      const c = await context();
      const item = await known(key);
      const made = await api('POST', `${c.base}/work-items/${item.id}/attachments/`, { name, type, size: bytes.length });
      if (!made) return null; // dry run
      const form = new FormData();
      for (const [k, v] of Object.entries(made.upload_data.fields)) form.append(k, v);
      form.append('file', new Blob([bytes], { type }), name);
      const up = await fetchImpl(made.upload_data.url, { method: 'POST', body: form });
      if (!up.ok) throw new Error(`upload of ${name}: ${up.status} ${await up.text()}`);
      await api('PATCH', `${c.base}/work-items/${item.id}/attachments/${made.asset_id}/`, { is_uploaded: true });
      return { id: made.asset_id, name };
    },
    /** Fetch a file a description or an attachment points at, with this client's key for Plane's own URLs. */
    download: async (url) => {
      const own = url.startsWith('/') || url.startsWith(origin) || url.startsWith(web);
      const res = await fetchImpl(url.startsWith('/') ? `${origin}${url}` : url, { headers: own ? { 'X-API-Key': apiKey } : {}, redirect: 'follow' });
      if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
      return { type: res.headers?.get?.('content-type') ?? '', bytes: Buffer.from(await res.arrayBuffer()) };
    },
    /** Where an attachment downloads from (Plane redirects to a signed URL). */
    attachmentUrl: async (key, id) => {
      const c = await context();
      const item = await known(key);
      return `${origin}/api/v1/workspaces/${workspace}/${c.base}/work-items/${item.id}/attachments/${id}/`;
    },
    editIssue: async (key, { body, title }) => {
      const item = await known(key);
      await patch(item, { ...(body != null ? { description_html: mdToHtml(body) } : {}), ...(title != null ? { name: title } : {}) });
    },
  };
}

/**
 * One client for a repository's issues and pull requests: work items go to
 * Plane, pull requests (and their labels, comments and events) to GitHub,
 * chosen by the reference: a key or a number.
 */
export function tracker(gh, plane) {
  const to = (ref) => (isKey(ref) ? plane : gh);
  return {
    ...gh,
    plane,
    openIssues: plane.openIssues,
    subIssues: plane.subIssues,
    blockers: plane.blockers,
    blocking: plane.blocking,
    inQA: plane.inQA,
    labelledItems: plane.labelledItems,
    createIssue: plane.createIssue,
    relate: plane.relate,
    attachments: plane.attachments,
    attach: plane.attach,
    download: plane.download,
    attachmentUrl: plane.attachmentUrl,
    setStage: plane.setStage,
    addLink: plane.addLink,
    findIssue: plane.find,
    seen: plane.seen,
    issue: (ref) => to(ref).issue(ref),
    addLabel: (ref, name) => to(ref).addLabel(ref, name),
    removeLabel: (ref, name) => to(ref).removeLabel(ref, name),
    comments: (ref) => to(ref).comments(ref),
    comment: (ref, body) => to(ref).comment(ref, body),
    editComment: (id, body) => (plane.ownsComment(id) ? plane.editComment(id, body) : gh.editComment(id, body)),
    events: (ref) => to(ref).events(ref),
    editIssue: (ref, patch) => to(ref).editIssue(ref, patch),
    // GitHub's issues are no longer the swarm's; only its pull requests' labels are.
    labelled: async (label) => (await gh.labelled(label)).filter((i) => i.pull_request),
    planeRateLimitRemaining: plane.rateLimitRemaining,
  };
}

/** The Plane client for a repository's work, from the environment; exits 2 when it can't be made. */
export function planeFromEnv(repo, env = process.env) {
  const projects = parseProjects(env.PLANE_PROJECTS || DEFAULT_PROJECTS);
  const project = projects.get(repo);
  const missing = [!env.PLANE_BASE_URL && 'PLANE_BASE_URL', !env.PLANE_API_TOKEN && 'PLANE_API_TOKEN'].filter(Boolean);
  if (missing.length || !project) {
    console.error(missing.length
      ? `${missing.join(' and ')} required: the swarm's work items are in Plane (PROTOCOL.md, "Where the work is").`
      : `PLANE_PROJECTS names no Plane project for ${repo}.`);
    process.exit(2);
  }
  return planeClient({
    baseUrl: env.PLANE_BASE_URL,
    webUrl: env.PLANE_WEB_URL || env.PLANE_BASE_URL,
    apiKey: env.PLANE_API_TOKEN,
    workspace: env.PLANE_WORKSPACE || 'couchy',
    project,
    repo,
    defaultRepo: [...projects].find(([, id]) => id === project)[0],
    qaState: env.PLANE_QA_STATE || 'QA',
    dryRun: env.DRY_RUN === 'true',
  });
}
