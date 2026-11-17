// node --test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PROJECTS, htmlToText, isKey, mdToHtml, parseProjects, planeClient, tracker } from './plane.mjs';
import { closingIssues, focus, linkedPulls, linkedTo, partOfIssues, whyNotClaimable } from './rules.mjs';
import { claim } from './tick.mjs';
import { followPulls, readLinked } from './sweep.mjs';
import { run } from './commands.mjs';

const PID = 'p1';
const STATES = [
  { id: 's-backlog', name: 'Backlog', group: 'backlog', default: true, sequence: 1 },
  { id: 's-todo', name: 'Todo', group: 'unstarted', sequence: 2 },
  { id: 's-doing', name: 'In Progress', group: 'started', sequence: 3 },
  { id: 's-done', name: 'Done', group: 'completed', sequence: 4 },
];

/** An in-memory Plane behind fetch: one project, its states, labels, work items, comments, links and cycle. */
function fakePlane({ items = [], labels = [], cycle = [], relations = {}, limit = null } = {}) {
  const calls = [];
  const comments = {};
  const links = {};
  let left = limit;
  const json = (status, body, headers = {}) => ({
    ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body),
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
  });
  const page = (results) => ({ results, next_page_results: false, next_cursor: null });
  const fetchImpl = async (url, { method = 'GET', body } = {}) => {
    const path = new URL(url).pathname.replace('/api/v1/workspaces/couchy/', '');
    calls.push(`${method} ${path}`);
    const headers = left == null ? {} : { 'x-ratelimit-remaining': String(left), 'x-ratelimit-reset': '100' };
    if (left != null) left -= 1;
    const data = body ? JSON.parse(body) : null;
    const item = (id) => items.find((i) => i.id === id);
    let m;
    if (path === 'projects/') return json(200, page([{ id: PID, identifier: 'COUCHYUX' }]), headers);
    if (path === `projects/${PID}/states/`) return json(200, page(STATES), headers);
    if (path === `projects/${PID}/labels/` && method === 'GET') return json(200, page(labels), headers);
    if (path === `projects/${PID}/labels/` && method === 'POST') {
      const made = { id: `l-${data.name}`, ...data };
      labels.push(made);
      return json(201, made, headers);
    }
    if (path === `projects/${PID}/issues/`) return json(200, page(items), headers);
    if ((m = /^work-items\/COUCHYUX-(\d+)\/$/.exec(path))) return json(200, items.find((i) => i.sequence_id === Number(m[1])), headers);
    if ((m = /^projects\/p1\/work-items\/([\w-]+)\/$/.exec(path)) && method === 'PATCH') {
      Object.assign(item(m[1]), data);
      return json(200, item(m[1]), headers);
    }
    if ((m = /^projects\/p1\/work-items\/([\w-]+)\/comments\/$/.exec(path))) {
      if (method === 'POST') (comments[m[1]] ??= []).push({ id: `c${Object.keys(comments).length}`, ...data });
      return json(method === 'POST' ? 201 : 200, method === 'POST' ? comments[m[1]].at(-1) : page(comments[m[1]] ?? []), headers);
    }
    if ((m = /^projects\/p1\/work-items\/([\w-]+)\/links\/$/.exec(path))) {
      if (method === 'POST') (links[m[1]] ??= []).push(data);
      return json(method === 'POST' ? 201 : 200, method === 'POST' ? data : page(links[m[1]] ?? []), headers);
    }
    if ((m = /^projects\/p1\/work-items\/([\w-]+)\/relations\/$/.exec(path))) return json(200, { blocked_by: relations[m[1]] ?? [] }, headers);
    if (path === `projects/${PID}/cycles/`) return json(200, cycle.length ? [{ id: 'cy1' }] : [], headers);
    if (path === `projects/${PID}/cycles/cy1/cycle-issues/`) return json(200, page(cycle.map((id) => item(id))), headers);
    if (path === `projects/${PID}/work-items/` && method === 'POST') {
      const made = { id: `new${items.length}`, sequence_id: 900 + items.length, created_at: 'x', ...data };
      items.push(made);
      return json(201, made, headers);
    }
    return json(404, { error: 'Page not found.' }, headers);
  };
  return { calls, comments, links, items, labels, fetchImpl };
}

const raw = (seq, extra = {}) => ({
  id: `i${seq}`, sequence_id: seq, name: `Item ${seq}`, description_html: '', labels: [], state: 's-todo',
  created_at: `2026-11-0${(seq % 9) + 1}T00:00:00Z`, updated_at: '2026-11-10T00:00:00Z', ...extra,
});
const client = (fake, more = {}) => planeClient({
  baseUrl: 'https://plane.home', apiKey: 'k', workspace: 'couchy', project: 'COUCHYUX',
  repo: 'getcouchy/couchy', fetchImpl: fake.fetchImpl, sleep: async () => {}, ...more,
});

test('keys and projects', () => {
  assert.ok(isKey('COUCHYUX-12'));
  assert.ok(!isKey(12));
  assert.ok(!isKey('#12'));
  assert.equal(parseProjects(DEFAULT_PROJECTS).get('getcouchy/couchy-agent'), 'COUCHYUX');
});

test('descriptions read as text; the tools\' Markdown is written as HTML with its markers kept', () => {
  assert.equal(htmlToText('<div><p>Part of <a href="x">#1678</a>.</p><p>Blocked by COUCHYUX-3 &amp; #5.</p></div>'), 'Part of #1678.\n\nBlocked by COUCHYUX-3 & #5.');
  assert.equal(
    mdToHtml('`claude-1` last ticked now\n\n<!-- agent-heartbeat: claude-1 -->'),
    '<p><code>claude-1</code> last ticked now</p><!-- agent-heartbeat: claude-1 -->',
  );
  assert.equal(mdToHtml('### Needs you\n\n- COUCHYUX-7 <b>x</b>\n- #57'), '<h3>Needs you</h3><ul><li>COUCHYUX-7 &lt;b&gt;x&lt;/b&gt;</li><li>#57</li></ul>');
});

test('a work item is shaped like an issue: key, stage, labels, repository, and the GitHub issue it came from', async () => {
  const fake = fakePlane({
    labels: [{ id: 'l1', name: 'swarm/focus' }, { id: 'l2', name: 'repo/couchy-agent' }],
    items: [
      raw(1, { external_source: 'github', external_id: 'getcouchy/couchy#1680', labels: ['l1'] }),
      raw(2, { external_source: 'github', external_id: 'getcouchy/couchy-agent#5' }),
      raw(3, { labels: ['l2'] }),
      raw(4, { state: 's-done' }),
    ],
  });
  const plane = client(fake);
  const open = await plane.openIssues();
  assert.deepEqual(open.map((i) => i.number), ['COUCHYUX-1'], 'only this repository\'s open items');
  const [one] = open;
  assert.deepEqual([one.stage, one.state, one.labels, one.aliases], ['unstarted', 'open', [{ name: 'swarm/focus' }], ['getcouchy/couchy#1680', 1680]]);
  assert.equal(one.html_url, 'https://plane.home/couchy/browse/COUCHYUX-1/');
  const agent = client(fake, { repo: 'getcouchy/couchy-agent', defaultRepo: 'getcouchy/couchy' });
  assert.deepEqual((await agent.openIssues()).map((i) => i.number), ['COUCHYUX-2', 'COUCHYUX-3']);
  assert.equal((await plane.find(1680)).number, 'COUCHYUX-1');
});

test('the current cycle is in focus, beside the label', async () => {
  const fake = fakePlane({ labels: [{ id: 'l1', name: 'swarm/focus' }], items: [raw(1, { labels: ['l1'] }), raw(2), raw(3)], cycle: ['i2'] });
  assert.deepEqual((await client(fake).openIssues(['swarm/focus'])).map((i) => i.number), ['COUCHYUX-1', 'COUCHYUX-2']);
});

test('labels: added to the list as Plane has it now, created in their group when new, removed under either name', async () => {
  const fake = fakePlane({ labels: [{ id: 'l1', name: 'area/app' }, { id: 'g', name: 'swarm' }], items: [raw(1, { labels: ['l1'] })] });
  const plane = client(fake);
  await plane.addLabel('COUCHYUX-1', 'swarm/agent/codex');
  assert.deepEqual(fake.items[0].labels, ['l1', 'l-swarm/agent/codex']);
  assert.equal(fake.labels.find((l) => l.name === 'swarm/agent/codex').parent, 'g');
  await plane.addLabel('COUCHYUX-1', 'swarm/agent/codex');
  assert.equal(fake.calls.filter((c) => c.startsWith('PATCH')).length, 1, 'already on: no write');
  await plane.removeLabel('COUCHYUX-1', 'swarm/agent/codex');
  assert.deepEqual(fake.items[0].labels, ['l1']);
});

test('the shared minute is waited out, not failed', async () => {
  const fake = fakePlane({ items: [raw(1)], limit: 1 });
  const waits = [];
  const plane = client(fake, { sleep: async (ms) => { waits.push(ms); }, now: () => 0 });
  await plane.openIssues();
  assert.ok(waits.length > 0, 'waits once the key has one request left');
});

test('blockers: relations and the description, by key or by the GitHub number an item came from', async () => {
  const fake = fakePlane({
    items: [
      raw(1, { description_html: '<p>Blocked by COUCHYUX-2, #1700 and #1. Blocks COUCHYUX-4.</p>' }),
      raw(2), raw(3, { external_source: 'github', external_id: 'getcouchy/couchy#1700', state: 's-done' }), raw(4), raw(5),
    ],
    relations: { i1: ['i5', 'elsewhere'] },
  });
  const plane = client(fake);
  const [item] = (await plane.openIssues()).filter((i) => i.number === 'COUCHYUX-1');
  assert.deepEqual(await plane.blockers(item), ['COUCHYUX-2', 'COUCHYUX-5', 'elsewhere (in another project)']);
});

test('a PR names a work item by key, or by the GitHub issue it was copied from', () => {
  assert.deepEqual(closingIssues('Closes COUCHYUX-12 and #4. Fixes flaky-2.'), ['COUCHYUX-12', 4]);
  assert.deepEqual(partOfIssues('Part of COUCHYUX-7 (2 of 3)'), ['COUCHYUX-7']);
  const linked = linkedPulls([{ number: 50, body: 'Closes #1680' }, { number: 51, body: 'Part of COUCHYUX-1' }]);
  const item = { number: 'COUCHYUX-1', aliases: ['getcouchy/couchy#1680', 1680], stage: 'unstarted', state: 'open', labels: [] };
  assert.deepEqual(linkedTo(linked, item).map((p) => p.number), [51, 50]);
  assert.match(whyNotClaimable(item, { linked }), /PR #51/);
  const f = focus([{ number: 'COUCHYUX-9', body: 'Wave 1: #1680, COUCHYUX-3', labels: [] }]);
  assert.equal(f.of(item), 'COUCHYUX-9');
});

test('tracker: work items go to Plane, pull requests to GitHub; a claimed Todo item moves to In Progress', async () => {
  const fake = fakePlane({ items: [raw(1)] });
  const log = [];
  const gh = {
    repo: 'getcouchy/couchy',
    issue: async (n) => ({ number: n, labels: [], pull_request: {} }),
    addLabel: async (n, name) => log.push(`gh add ${n} ${name}`),
    removeLabel: async () => {},
  };
  const t = tracker(gh, client(fake));
  assert.equal(await claim(t, 'COUCHYUX-1', 'codex'), true);
  assert.equal(fake.items[0].state, 's-doing');
  await t.addLabel(57, 'swarm/agent/codex');
  assert.deepEqual(log, ['gh add 57 swarm/agent/codex']);
});

test('commands take a key; the event names the item by repository, number and key', async () => {
  const fake = fakePlane({ items: [raw(12)] });
  const gh = { repo: 'getcouchy/couchy', rateLimitRemaining: () => 10 };
  const t = tracker(gh, client(fake));
  const { out, event } = await run('needs-human', ['COUCHYUX-12', 'Which', 'one?'], { clients: [t], me: 'codex' });
  assert.deepEqual([out.commented, out.labelled], [true, true]);
  assert.match(fake.comments.i12[0].comment_html, /Which one\?/);
  const line = await event();
  assert.deepEqual([line.repo, line.number, line.type, line.key], ['getcouchy/couchy', 12, 'issue', 'COUCHYUX-12']);
});

test('sweep: work items follow their PRs, each link added once', async () => {
  const fake = fakePlane({ items: [raw(1, { state: 's-backlog' }), raw(2, { external_source: 'github', external_id: 'getcouchy/couchy#1680', state: 's-doing' })] });
  const plane = client(fake);
  const now = Date.parse('2026-11-16T12:00:00Z');
  const gh = tracker({
    repo: 'getcouchy/couchy',
    closedPulls: async () => [
      { number: 60, title: 'Old', body: 'Closes #1680', merged_at: '2026-11-16T10:00:00Z', html_url: 'https://github.com/x/60' },
      { number: 61, title: 'Shut', body: 'Closes COUCHYUX-1', merged_at: null, html_url: 'https://github.com/x/61' },
    ],
  }, plane);
  const pulls = [{ number: 57, title: 'Work', body: 'Part of COUCHYUX-1', html_url: 'https://github.com/x/57' }];
  const { lines, linked } = await followPulls(gh, { pulls, desk: null, now });
  assert.deepEqual(lines, ['COUCHYUX-1 is In Progress: PR #57 is open for it.', 'COUCHYUX-2 is Done: PR #60 merged.']);
  assert.deepEqual([fake.items[0].state, fake.items[1].state], ['s-doing', 's-done']);
  assert.deepEqual(fake.links.i1, [{ url: 'https://github.com/x/57', title: 'PR #57: Work' }]);
  const again = await followPulls(gh, { pulls, desk: { html: `<!-- swarm-linked: ${JSON.stringify(linked)} -->` }, now });
  assert.deepEqual(again.lines, []);
  assert.equal(fake.links.i1.length, 1);
  assert.deepEqual(readLinked('nothing'), []);
});
