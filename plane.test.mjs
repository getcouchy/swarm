// node --test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PROJECTS, htmlToText, isKey, mdToHtml, parseProjects, planeClient, tracker } from './plane.mjs';
import { bodyBlockers, closingIssues, linkedPulls, linkedTo, needsQA, partOfIssues, whyNotClaimable } from './rules.mjs';
import { claim, focusOf } from './tick.mjs';
import { followPulls, readLinked, writeDesk } from './sweep.mjs';
import { run } from './commands.mjs';

const PID = 'p1';
const STATES = [
  { id: 's-backlog', name: 'Backlog', group: 'backlog', default: true, sequence: 1 },
  { id: 's-todo', name: 'Todo', group: 'unstarted', sequence: 2 },
  { id: 's-doing', name: 'In Progress', group: 'started', sequence: 3 },
  { id: 's-done', name: 'Done', group: 'completed', sequence: 4 },
];

/** An in-memory Plane behind fetch: one project, its states, labels, work items, comments, links and cycle. */
function fakePlane({ items = [], labels = [], cycle = [], relations = {}, blocking = {}, limit = null, states = STATES } = {}) {
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
    if (path === `projects/${PID}/states/`) return json(200, page(states), headers);
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
    if ((m = /^projects\/p1\/work-items\/([\w-]+)\/comments\/([\w-]+)\/$/.exec(path)) && method === 'PATCH') {
      const c = comments[m[1]].find((x) => x.id === m[2]);
      Object.assign(c, data);
      return json(200, c, headers);
    }
    if ((m = /^projects\/p1\/work-items\/([\w-]+)\/comments\/$/.exec(path))) {
      if (method === 'POST') (comments[m[1]] ??= []).push({ id: `c${(comments[m[1]] ?? []).length}`, ...data });
      return json(method === 'POST' ? 201 : 200, method === 'POST' ? comments[m[1]].at(-1) : page(comments[m[1]] ?? []), headers);
    }
    if ((m = /^projects\/p1\/work-items\/([\w-]+)\/links\/$/.exec(path))) {
      if (method === 'POST') (links[m[1]] ??= []).push(data);
      return json(method === 'POST' ? 201 : 200, method === 'POST' ? data : page(links[m[1]] ?? []), headers);
    }
    if ((m = /^projects\/p1\/work-items\/([\w-]+)\/relations\/$/.exec(path))) return json(200, { blocked_by: relations[m[1]] ?? [], blocking: blocking[m[1]] ?? [] }, headers);
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

test('priority comes from Plane; blocking relations name the open items that wait, read once with the blockers', async () => {
  const fake = fakePlane({
    items: [raw(1, { priority: 'urgent' }), raw(2), raw(3, { state: 's-done' })],
    relations: { i1: ['i2'] },
    blocking: { i1: ['i2', 'i3', 'elsewhere'] },
  });
  const plane = client(fake);
  const [one, two] = await plane.openIssues();
  assert.deepEqual([one.priority, two.priority], ['urgent', 'none']);
  assert.deepEqual(await plane.blocking(one), ['COUCHYUX-2'], 'a done item and one in another project wait on nothing here');
  await plane.blockers(one);
  assert.equal(fake.calls.filter((c) => c.includes('/relations/')).length, 1);
});

test('a PR names a work item by key, or by the GitHub issue it was copied from', async () => {
  assert.deepEqual(closingIssues('Closes COUCHYUX-12 and #4. Fixes flaky-2.'), ['COUCHYUX-12', 4]);
  assert.deepEqual(partOfIssues('Part of COUCHYUX-7 (2 of 3)'), ['COUCHYUX-7']);
  const linked = linkedPulls([{ number: 50, body: 'Closes #1680' }, { number: 51, body: 'Part of COUCHYUX-1' }]);
  const item = { number: 'COUCHYUX-1', aliases: ['getcouchy/couchy#1680', 1680], stage: 'unstarted', state: 'open', labels: [] };
  assert.deepEqual(linkedTo(linked, item).map((p) => p.number), [51, 50]);
  assert.match(whyNotClaimable(item, { linked }), /PR #51/);
  // A sprint item's blocker named by the GitHub issue it was copied from is in focus.
  const sprint = { number: 'COUCHYUX-9', labels: [] };
  const f = await focusOf({ openIssues: async () => [sprint], subIssues: async () => [], blockers: async (i) => (i === sprint ? ['#1680'] : []) }, [sprint, item]);
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

test('QA: work that touches what people use waits there for the owner; backend work goes to Done', () => {
  const item = (...names) => ({ labels: names.map((name) => ({ name })) });
  assert.ok(needsQA(item('area/app', 'platform/web')));
  assert.ok(needsQA(item('area/api', 'platform/ios')), 'an API change with a UI label is a UI change');
  assert.ok(!needsQA(item('area/api', 'effort/small')));
  assert.ok(!needsQA(item('area/tooling')));
  assert.ok(needsQA(item('area/ci', 'swarm/qa')), 'an agent may send backend work to QA');
  assert.ok(needsQA(item('kind/bug')), 'with no label that says backend only, it goes to QA');
});

test('QA state: no agent takes an item there and it blocks nothing; merges move it once, so a failed QA stays in Todo', async () => {
  const states = [...STATES, { id: 's-qa', name: 'QA', group: 'started', sequence: 3.5 }];
  const fake = fakePlane({
    states,
    labels: [{ id: 'l-app', name: 'area/app' }, { id: 'l-api', name: 'area/api' }],
    items: [
      raw(1, { state: 's-doing', labels: ['l-app'] }),
      raw(2, { state: 's-doing', labels: ['l-api'] }),
      raw(3, { state: 's-qa' }),
      raw(4, { description_html: '<p>Blocked by COUCHYUX-3.</p>' }),
      raw(5),
    ],
  });
  const plane = client(fake);
  const open = await plane.openIssues();
  assert.deepEqual(open.map((i) => i.number), ['COUCHYUX-1', 'COUCHYUX-2', 'COUCHYUX-4', 'COUCHYUX-5'], 'an item in QA is not open work');
  assert.deepEqual((await plane.inQA()).map((i) => [i.number, i.stage]), [['COUCHYUX-3', 'qa']]);
  assert.deepEqual(await plane.blockers(open[2]), [], 'an item in QA blocks nothing');
  // A claim moves Todo to In Progress, never to QA, though both are in the started group.
  assert.equal(await plane.setStage('COUCHYUX-5', 'started'), 'started');
  assert.equal(fake.items[4].state, 's-doing');

  const now = Date.parse('2026-11-16T12:00:00Z');
  const merged = (number, body) => ({ number, title: `PR ${number}`, body, merged_at: '2026-11-16T10:00:00Z', html_url: `https://github.com/x/${number}` });
  const gh = tracker({ repo: 'getcouchy/couchy', closedPulls: async () => [merged(60, 'Closes COUCHYUX-1'), merged(61, 'Closes COUCHYUX-2')] }, client(fake));
  const first = await followPulls(gh, { pulls: [], now });
  assert.deepEqual(first.lines, ['COUCHYUX-1 is in QA: PR #60 merged.', 'COUCHYUX-2 is Done: PR #61 merged.']);
  assert.deepEqual([fake.items[0].state, fake.items[1].state], ['s-qa', 's-done']);
  // The owner sends COUCHYUX-1 back to Todo; the same merge doesn't move it again.
  fake.items[0].state = 's-todo';
  const stored = `<!-- swarm-linked: ${JSON.stringify(first.linked)} -->`;
  const again = await followPulls(tracker({ repo: 'getcouchy/couchy', closedPulls: async () => [merged(60, 'Closes COUCHYUX-1')] }, client(fake)), { pulls: [], stored, now });
  assert.deepEqual(again.lines, []);
  assert.equal(fake.items[0].state, 's-todo');
});

test('desk in Plane: the markers live in one comment the sweep edits, so the next run remembers what it said', async () => {
  const fake = fakePlane({ items: [] });
  const gh = tracker({ repo: 'getcouchy/couchy' }, client(fake));
  const overdue = [{ section: 'Needs you', key: 'human:COUCHYUX-7', line: 'COUCHYUX-7 Item 7' }];
  await writeDesk(gh, { desk: null, overdue, fixed: [], linked: ['COUCHYUX-1<57'], now: Date.parse('2026-11-16T12:00:00Z') });
  const [desk] = fake.items;
  assert.doesNotMatch(desk.description_html, /<!--/, 'Plane drops comments from a description, so none are put there');
  const posted = () => fake.comments[desk.id].map((c) => c.comment_html);
  assert.equal(posted().length, 2, 'the state, then what is newly overdue');
  assert.match(posted()[0], /<!-- agent-desk-state: \["human:COUCHYUX-7"\] -->/);
  assert.match(posted()[0], /<!-- swarm-linked: \["COUCHYUX-1<57"\] -->/);

  // The next run reads it back as sweep() would find it, and has nothing new to say.
  const plane = client(fake);
  const again = tracker({ repo: 'getcouchy/couchy' }, plane);
  const key = `COUCHYUX-${desk.sequence_id}`;
  const stateComment = (await again.comments(key)).find((c) => /agent-desk-state/.test(c.body));
  const shaped = await plane.issue(key);
  await writeDesk(again, { desk: shaped, stateComment, overdue, fixed: [], now: Date.parse('2026-11-16T12:10:00Z') });
  assert.equal(posted().length, 2, 'edited in place; no second "newly overdue"');
  assert.deepEqual(readLinked(posted()[0]), [], 'rewritten from this run alone: here it passed no linked pairs');
});

test('events: a work item carries its title from what the tracker read, a PR its own; the line asks Plane nothing', async () => {
  const fake = fakePlane({ items: [raw(12), raw(13, { labels: ['l-agent'] })], labels: [{ id: 'l-agent', name: 'swarm/agent/codex' }], cycle: ['i12'] });
  const pulls = [{ number: 57, title: 'Fix login', labels: [{ name: 'swarm/pr' }, { name: 'swarm/agent/codex' }] }];
  const gh = {
    repo: 'getcouchy/couchy',
    rateLimitRemaining: () => 10,
    openPulls: async () => pulls,
    requiredChecks: async () => [],
    issue: async (n) => ({ ...pulls.find((p) => p.number === n), pull_request: {} }),
    removeLabel: async () => {},
  };
  // A fresh tracker for each command: the title comes from what that command read.
  const line = async (cmd, args) => {
    const { event } = await run(cmd, args, { clients: [tracker(gh, client(fake))], me: 'codex', ceiling: 45, entry: 'agent.mjs' });
    const before = fake.calls.length;
    const { v, at, rateLimitRemaining, ...rest } = await event();
    assert.equal(fake.calls.length, before, `${cmd}: no Plane call for its line`);
    return rest;
  };
  const twelve = { repo: 'getcouchy/couchy', number: 12, type: 'issue', key: 'COUCHYUX-12', title: 'Item 12' };
  const thirteen = { repo: 'getcouchy/couchy', number: 13, type: 'issue', key: 'COUCHYUX-13', title: 'Item 13' };
  const pr = { repo: 'getcouchy/couchy', number: 57, type: 'pull', title: 'Fix login' };
  assert.deepEqual(await line('claim', ['COUCHYUX-12']), { cmd: 'claim', ...twelve, claimed: [twelve] });
  assert.deepEqual(await line('needs-human', ['COUCHYUX-12', 'Which', 'one?']), { cmd: 'needs-human', ...twelve });
  assert.deepEqual(await line('release', ['COUCHYUX-12']), { cmd: 'release', ...twelve, released: [twelve] });
  assert.deepEqual(await line('release', ['57']), { cmd: 'release', ...pr, released: [pr] });
  assert.deepEqual(await line('finish', []), { cmd: 'finish', released: [thirteen, pr] });

  // next: the job's work item, titled, in the line and in what it claimed.
  pulls.length = 0;
  fake.items.splice(1);
  fake.items[0].labels = [];
  fake.items[0].state = 's-todo';
  assert.deepEqual(await line('next', []), { cmd: 'next', job: 'implement', ...twelve, claimed: [twelve] });
});

test('descriptions read as Markdown that writes back the same: headings, lists, tables, images, code', () => {
  const html = '<h3>Scope</h3><ul><li><p>One <code>x</code></p></li><li><p>Two</p></li></ul><p>Blocked by COUCHYUX-3 &amp; #5.</p>'
    + '<p><a href="https://github.com/o/r/blob/main/a.png"><img src="https://plane.home/uploads/a.png" alt="A" style="max-width: 100%;"></a></p>'
    + '<table><thead><tr><th>Part</th><th>Spec</th></tr></thead><tbody><tr><td>Rail</td><td>44 <strong>high</strong> | wide</td></tr></tbody></table>'
    + '<ol><li><p>first</p></li><li><p>second</p></li></ol><pre><code>a &lt; b</code></pre><hr><p>See <a href="https://x.dev/doc">the doc</a>.</p>';
  const md = htmlToText(html);
  assert.equal(md, [
    '### Scope', '', '- One `x`', '- Two', '', 'Blocked by COUCHYUX-3 & #5.', '', '![A](https://plane.home/uploads/a.png)', '',
    '| Part | Spec |', '| --- | --- |', '| Rail | 44 **high** \\| wide |', '', '1. first', '1. second', '', '```', 'a < b', '```', '', '---', '', 'See [the doc](https://x.dev/doc).',
  ].join('\n'));
  assert.equal(htmlToText(mdToHtml(md)), md);
  assert.match(mdToHtml(md), /<img src="https:\/\/plane.home\/uploads\/a.png" alt="A">/);
  assert.match(mdToHtml(md), /<td>44 <strong>high<\/strong> \| wide<\/td>/);
  assert.deepEqual(bodyBlockers(md).map((b) => b.key ?? b.number), ['COUCHYUX-3', 5]);
});

test('shaping: a claimed Todo item being shaped stays in Todo; child items are made in Backlog under their parent; relations and attachments', async () => {
  const fake = fakePlane({ items: [raw(1, { labels: ['lg'] }), raw(2)], labels: [{ id: 'lg', name: 'swarm/groom' }] });
  const uploads = [];
  const fetchImpl = async (url, opts = {}) => {
    const path = new URL(url).pathname.replace('/api/v1/workspaces/couchy/', '');
    const method = opts.method ?? 'GET';
    const json = (status, body) => ({ ok: true, status, json: async () => body, text: async () => '', headers: { get: () => null } });
    if (url.startsWith('https://plane.home/uploads')) {
      uploads.push([...opts.body.keys()]);
      return { ok: true, status: 204, text: async () => '' };
    }
    if (/attachments\/$/.test(path) && method === 'POST') {
      fake.calls.push(`POST ${path} ${opts.body}`);
      return json(200, { asset_id: 'a1', upload_data: { url: 'https://plane.home/uploads', fields: { key: 'w/a1-board.png', 'Content-Type': 'image/png' } } });
    }
    if (/attachments\/a1\/$/.test(path) || (/relations\/$/.test(path) && method === 'POST')) {
      fake.calls.push(`${method} ${path} ${opts.body}`);
      return { ok: true, status: 204, text: async () => '', headers: { get: () => null } };
    }
    return fake.fetchImpl(url, opts);
  };
  const plane = client(fake, { fetchImpl });
  const t = tracker({ repo: 'getcouchy/couchy' }, plane);
  assert.equal(await claim(t, 'COUCHYUX-1', 'claude-shape-1'), true);
  assert.equal(fake.items[0].state, 's-todo', 'shaping is not building');

  const child = await t.createIssue('Slice one', '### Scope\n\n- this', ['swarm/shaped'], { parent: 'COUCHYUX-1', priority: 'high' });
  const made = fake.items.at(-1);
  assert.deepEqual([made.state, made.parent, made.priority, made.description_html], ['s-backlog', 'i1', 'high', '<h3>Scope</h3><ul><li>this</li></ul>']);
  await t.relate(child.key, 'blocked_by', ['COUCHYUX-2']);
  assert.ok(fake.calls.includes(`POST projects/p1/work-items/${made.id}/relations/ {"relation_type":"blocked_by","issues":["i2"]}`));

  const bytes = Buffer.from('png');
  assert.deepEqual(await t.attach('COUCHYUX-1', { name: 'board.png', type: 'image/png', bytes }), { id: 'a1', name: 'board.png' });
  assert.ok(fake.calls.includes('POST projects/p1/work-items/i1/attachments/ {"name":"board.png","type":"image/png","size":3}'));
  assert.deepEqual(uploads, [['key', 'Content-Type', 'file']], 'the presigned fields, then the file');
  assert.ok(fake.calls.includes('PATCH projects/p1/work-items/i1/attachments/a1/ {"is_uploaded":true}'));
});
