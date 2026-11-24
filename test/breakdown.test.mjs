// node --test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BreakdownUsage, breakdownCommand, titled } from '../lib/breakdown.mjs';

/** A work item's tracker, in memory: one item and what the commands did to it. */
function fakeClient(item, { comments = [], attachments = [], files = {}, others = [], blocking = {} } = {}) {
  const log = [];
  const labels = () => item.labels.map((l) => l.name);
  const known = () => [item, ...others];
  return {
    log,
    item,
    files,
    made: [],
    issue: async (key) => structuredClone(known().find((i) => i.key === key) ?? null),
    openIssues: async () => structuredClone(known()),
    blocking: async (i) => blocking[i.key] ?? [],
    setStage: async (key, stage) => { log.push(`stage ${key} ${stage}`); return stage; },
    comments: async () => comments,
    subIssues: async () => ['COU-9'],
    seen: (k) => (k === 'COU-9' ? { title: 'Child', stage: 'completed' } : null),
    blockers: async () => ['COU-2'],
    attachments: async () => attachments,
    attachmentUrl: async (key, id) => `https://uploads.linear.app/w/${id}/`,
    download: async (url) => ({ type: url.endsWith('/a1/') ? 'image/png' : 'image/jpeg', bytes: Buffer.from(url) }),
    comment: async (key, md) => log.push(`comment ${md.split('\n')[0]}`),
    editIssue: async (key, { body, title }) => { log.push(`describe ${body}${title ? ` as ${title}` : ''}`); },
    addLabel: async (key, name) => { log.push(`add ${name}`); if (!labels().includes(name)) item.labels.push({ name }); },
    removeLabel: async (key, name) => { log.push(`remove ${name}`); item.labels = item.labels.filter((l) => l.name !== name); },
    createIssue: async function (title, body, ls, opts) { this.made.push({ title, body, labels: ls, ...opts }); log.push(`create ${title}`); return { key: 'COU-50', html_url: 'u' }; },
    relate: async (key, kind, keys) => log.push(`relate ${key} ${kind} ${keys}`),
    attach: async (key, f) => { log.push(`attach ${f.name} ${f.type} ${f.bytes.length}`); return { id: 'x', name: f.name }; },
  };
}
const item = (labels = ['swarm/task-breakdown', 'swarm/agent/claude-task-breakdown-1'], extra = {}) => ({
  key: 'COU-7', number: 'COU-7', title: 'Seven', html_url: 'https://linear.app/couchy/issue/COU-7/seven', stage: 'backlog', priority: 'high',
  labels: labels.map((name) => ({ name })), parent: null, body: 'Old text.\n\n![Board](https://uploads.linear.app/w/b.png)', ...extra,
});
const me = 'claude-task-breakdown-1';
const run = (cmd, args, client, more = {}) => breakdownCommand(cmd, args, { client, me, readFile: (f) => client.files[f], ...more });

test('show: the work item as Markdown, with its comments, children, blockers and attachments', async () => {
  const c = fakeClient(item(), { comments: [{ created_at: 't', body: 'Make it **smaller**.' }], attachments: [{ id: 'a1', name: 'board.png' }] });
  const out = await run('show', ['COU-7'], c);
  assert.equal(out.description, 'Old text.\n\n![Board](https://uploads.linear.app/w/b.png)');
  assert.deepEqual(out.comments, [{ at: 't', text: 'Make it **smaller**.' }]);
  assert.deepEqual(out.children, [{ key: 'COU-9', title: 'Child', stage: 'completed' }]);
  assert.deepEqual([out.blockers, out.attachments.map((a) => a.name)], [['COU-2'], ['board.png']]);
});

test('show: a sub-issue names its parent by key', async () => {
  const c = fakeClient(item(undefined, { parent: 'i3' }), { others: [{ ...item([]), key: 'COU-3', number: 'COU-3', id: 'i3' }] });
  assert.equal((await run('show', ['COU-7'], c)).parent, 'COU-3');
});

test('images: every image the description shows and every attachment, saved where the agent can read them', async () => {
  const c = fakeClient(item(), { attachments: [{ id: 'a1', name: 'wire frame.png' }] });
  const written = [];
  const out = await run('images', ['COU-7'], c, { dir: '/tmp/t', mkdir: () => {}, writeFile: (p) => written.push(p) });
  assert.deepEqual(out.files.map((f) => f.path), ['/tmp/t/swarm-images/COU-7/01-b.png', '/tmp/t/swarm-images/COU-7/02-wire-frame.png']);
  assert.deepEqual(written, out.files.map((f) => f.path));
});

test('images: a comment\'s screenshots too, named by their alt text, each image once', async () => {
  const shot = 'https://uploads.linear.app/w/fa61?signature=x';
  const c = fakeClient(item(), {
    comments: [
      { created_at: '2026-11-19T00:17:34Z', body: `QA failed: criterion 1.\n\n![image.png](${shot})` },
      { created_at: '2026-11-19T01:00:00Z', body: `Same again: ![image.png](${shot})` },
      { created_at: '2026-11-19T02:00:00Z', body: 'No picture.' },
    ],
  });
  const out = await run('images', ['COU-7'], c, { dir: '/tmp/t', mkdir: () => {}, writeFile: () => {} });
  assert.deepEqual(out.files.map((f) => [f.source, f.path]), [
    ['description', '/tmp/t/swarm-images/COU-7/01-b.png'],
    ['comment 2026-11-19T00:17:34Z', '/tmp/t/swarm-images/COU-7/02-image.png'],
  ]);
});

test('changes need the lock; describe keeps the old description in a comment', async () => {
  const unlocked = fakeClient(item(['swarm/task-breakdown']), { files: { 'd.md': 'New.' } });
  await assert.rejects(run('describe', ['COU-7', 'd.md'], unlocked), (e) => e instanceof BreakdownUsage && /claim it first/.test(e.message));
  const c = fakeClient(item(), { files: { 'd.md': '### Scope\n\n- New.' } });
  assert.deepEqual(await run('describe', ['COU-7', 'd.md'], c), { key: 'COU-7', described: true });
  assert.deepEqual(c.log, ['comment The description before claude-task-breakdown-1 rewrote it:', 'describe ### Scope\n\n- New.']);
});

test('describe: --title renames the item too, for one rewritten as its last slice', async () => {
  const c = fakeClient(item(), { files: { 'd.md': '### Scope\n\n- The last part.' } });
  await run('describe', ['COU-7', 'd.md', '--title=Seven 3: the last part'], c);
  assert.equal(c.log.at(-1), 'describe ### Scope\n\n- The last part. as Seven 3: the last part');
});

const SPLIT = ['swarm/task-breakdown', 'swarm/agent/claude-task-breakdown-1', 'swarm/focus', 'swarm/needs/ios-sim', 'platform/web', 'area/app', 'repo/couchy-agent'];

test('create: a slice is a sibling, not a child, with the item\'s product labels, focus, needs, project, priority and sprint', async () => {
  assert.deepEqual(titled('# Slice one\n\nBody.'), { title: 'Slice one', body: 'Body.' });
  assert.throws(() => titled('No heading'), BreakdownUsage);
  const c = fakeClient(item(SPLIT, { project: 'p1', cycle: 'cy1', sprint: true }), { files: { 's.md': '# Slice one\n\n### Scope\n\n- this' } });
  const out = await run('create', ['COU-7', 's.md'], c);
  assert.deepEqual(c.made, [{
    title: 'Slice one', body: '### Scope\n\n- this',
    labels: ['swarm/focus', 'swarm/needs/ios-sim', 'platform/web', 'area/app', 'repo/couchy-agent'],
    priority: 'high', project: 'p1', cycle: 'cy1',
  }]);
  assert.deepEqual([out.from, out.created, out.url], ['COU-7', 'COU-50', 'u']);
  assert.equal('parent' in out, false);
});

test('create: --labels adds, takes the place of the item\'s label in the same group, and drops one with a minus; swarm labels are not the agent\'s to add; --priority wins', async () => {
  // In an earlier cycle, not the sprint: the slice goes in none.
  const c = fakeClient(item(SPLIT, { project: null, cycle: 'cy0', sprint: false }), { files: { 's.md': '# API slice\n\nBody.' } });
  const out = await run('create', ['COU-7', 's.md', '--labels=area/api,-platform/web,-swarm/needs/ios-sim,swarm/hold', '--blocked-by=COU-2,COU-3', '--priority=low'], c);
  assert.deepEqual(c.made[0].labels, ['swarm/focus', 'repo/couchy-agent', 'area/api']);
  assert.deepEqual([c.made[0].priority, c.made[0].project, c.made[0].cycle], ['low', null, null]);
  assert.deepEqual(out.labels, c.made[0].labels);
  assert.deepEqual(c.log, ['create API slice', 'relate COU-50 blocked_by COU-2,COU-3']);
});

test('labels: product labels only; attach: known file types', async () => {
  const c = fakeClient(item(), { files: { 'b.png': Buffer.from('png!'), 'x.exe': Buffer.from('') } });
  assert.deepEqual(await run('labels', ['COU-7', '+platform/web', '-area/api'], c), { key: 'COU-7', added: ['platform/web'], removed: ['area/api'] });
  await assert.rejects(run('labels', ['COU-7', '-swarm/task-breakdown'], c), /own commands/);
  assert.deepEqual(await run('attach', ['COU-7', 'b.png'], c), { key: 'COU-7', attached: ['b.png'] });
  await assert.rejects(run('attach', ['COU-7', 'x.exe'], c), /attach takes/);
  assert.deepEqual(c.log, ['remove area/api', 'add platform/web', 'attach b.png image/png 4'], 'removals first, so a one-label group can swap');
});

test('submit: the summary, then the request and the lock come off', async () => {
  const c = fakeClient(item(['swarm/design', 'swarm/task-breakdown', 'swarm/agent/claude-task-breakdown-1', 'platform/web']));
  await assert.rejects(run('submit', ['COU-7'], c), /Usage/);
  assert.deepEqual(await run('submit', ['COU-7', 'Spec in getcouchy/couchy-design#40.'], c), { key: 'COU-7', submitted: true, released: ['COU-7'] });
  assert.deepEqual(c.log, ['comment Spec in getcouchy/couchy-design#40.', 'remove swarm/task-breakdown', 'remove swarm/design', 'remove swarm/agent/claude-task-breakdown-1']);
  assert.deepEqual(c.item.labels.map((l) => l.name), ['platform/web']);
});

test('submit: a technical design keeps its label and waits in Review until its PR merges', async () => {
  const c = fakeClient(item(['swarm/tech-design', 'swarm/agent/claude-task-breakdown-1', 'area/app'], { stage: 'unstarted' }));
  assert.deepEqual(await run('submit', ['COU-7', 'Design in getcouchy/couchy-design#154.'], c), { key: 'COU-7', submitted: true, stage: 'qa', released: ['COU-7'] });
  assert.deepEqual(c.log, ['comment Design in getcouchy/couchy-design#154.', 'stage COU-7 qa', 'remove swarm/agent/claude-task-breakdown-1'], 'in Review before the lock comes off, so no other architect tick takes it');
  assert.deepEqual(c.item.labels.map((l) => l.name), ['swarm/tech-design', 'area/app']);
  const merged = fakeClient(item(['swarm/tech-design', 'swarm/agent/claude-task-breakdown-1'], { stage: 'completed', state: 'closed' }));
  assert.equal((await run('submit', ['COU-7', 'Design.'], merged)).stage, 'completed', 'a design the owner has merged already stays Done');
  assert.ok(!merged.log.some((l) => l.startsWith('stage')));
});

test('create: a slice of an item with no labels of its own has none, like one a technical design asks for', async () => {
  const c = fakeClient(item(['swarm/task-breakdown', 'swarm/agent/claude-task-breakdown-1']), { files: { 's.md': '# Slice\n\nBody.' } });
  await run('create', ['COU-7', 's.md'], c);
  assert.deepEqual(c.made[0].labels, []);
});

test('create: a label the tracker has retired stays behind', async () => {
  const from = item(['swarm/agent/claude-task-breakdown-1', 'platform/web', 'area/app']);
  from.labels.find((l) => l.name === 'area/app').retired = true;
  const c = fakeClient(from, { files: { 's.md': '# Slice\n\nBody.' } });
  await run('create', ['COU-7', 's.md'], c);
  assert.deepEqual(c.made[0].labels, ['platform/web']);
});

test('submit --replaced-by: what waited on the item waits on its last slices, then the item is closed', async () => {
  const other = (key, body = '') => ({ ...item([]), key, number: key, id: key, title: key, body });
  const c = fakeClient(item(['swarm/task-breakdown', 'swarm/agent/claude-task-breakdown-1', 'platform/web'], { id: 'COU-7' }), {
    // COU-71 names it in its description only. COU-51 waits on COU-50 and COU-53 on COU-52 (in its description
    // only), so COU-51 and COU-53 are the last slices.
    others: [other('COU-50'), other('COU-51'), other('COU-52'), other('COU-53', 'Blocked by COU-52.'), other('COU-70'), other('COU-71', 'Blocked by COU-7.'), other('COU-72', 'Blocked by COU-3.')],
    blocking: { 'COU-7': ['COU-70', 'COU-50'], 'COU-50': ['COU-51'] },
  });
  const out = await run('submit', ['COU-7', 'Four slices.', '--replaced-by=COU-50,COU-51,COU-52,COU-53'], c);
  assert.deepEqual(c.log, [
    'relate COU-70 blocked_by COU-51,COU-53',
    'relate COU-71 blocked_by COU-51,COU-53',
    'comment Four slices.',
    'remove swarm/task-breakdown',
    'remove swarm/agent/claude-task-breakdown-1',
    'stage COU-7 cancelled',
  ], 'the relations move before the item closes, so nothing is free to start in between');
  assert.deepEqual(out, {
    key: 'COU-7', submitted: true, closed: true, replacedBy: ['COU-50', 'COU-51', 'COU-52', 'COU-53'],
    waiting: ['COU-70', 'COU-71'], waitOn: ['COU-51', 'COU-53'], released: ['COU-7'],
  });
});

test('submit --filed: a "Task breakdown" item is Done with its label; what waited on it waits on the last of the work it filed', async () => {
  const other = (key, body = '') => ({ ...item([]), key, number: key, id: key, title: key, body });
  const c = fakeClient(item(['swarm/task-breakdown', 'swarm/agent/claude-task-breakdown-1'], { id: 'COU-7' }), {
    others: [other('COU-50'), other('COU-51', 'Blocked by COU-50.'), other('COU-70')], blocking: { 'COU-7': ['COU-70'] },
  });
  const out = await run('submit', ['COU-7', 'Two packages.', '--filed=COU-50,COU-51'], c);
  assert.deepEqual(c.log, ['relate COU-70 blocked_by COU-51', 'comment Two packages.', 'stage COU-7 completed', 'remove swarm/agent/claude-task-breakdown-1'], 'Done before the lock comes off, so nothing is filed twice');
  assert.deepEqual(c.item.labels.map((l) => l.name), ['swarm/task-breakdown']);
  assert.deepEqual(out, { key: 'COU-7', submitted: true, closed: true, filed: ['COU-50', 'COU-51'], waiting: ['COU-70'], waitOn: ['COU-51'], released: ['COU-7'] });
});

test('submit --replaced-by: a key that is no work item stops it before anything changes', async () => {
  const c = fakeClient(item());
  await assert.rejects(run('submit', ['COU-7', 'Two slices.', '--replaced-by=COU-50,COU-99'], c), (e) => e instanceof BreakdownUsage && /COU-50, COU-99: no such work item/.test(e.message));
  assert.deepEqual(c.log, []);
});

const BUILDING = ['swarm/agent/claude-task-breakdown-1', 'swarm/focus', 'swarm/qa', 'area/app'];

test('create --sub: a part of the item being built is its sub-issue, with its labels but not its QA', async () => {
  const c = fakeClient(item(BUILDING, { stage: 'started', project: 'p1', cycle: 'cy1', sprint: true }), { files: { 's.md': '# Part one\n\nBody.' } });
  const out = await run('create', ['COU-7', 's.md', '--sub', '--blocked-by=COU-2'], c);
  assert.deepEqual(c.made, [{ title: 'Part one', body: 'Body.', labels: ['swarm/focus', 'area/app'], parent: 'COU-7', priority: 'high', project: 'p1', cycle: 'cy1' }]);
  assert.equal(out.parent, 'COU-7');
  assert.deepEqual(c.log, ['create Part one', 'relate COU-50 blocked_by COU-2'], 'it stays in Backlog until submit --split');
});

test('create --sub and submit --split: only work the owner approved is split, and never a task-breakdown tick\'s item', async () => {
  const part = { ...item([]), key: 'COU-50', number: 'COU-50', id: 'COU-50', parent: 'i7' };
  for (const [labels, stage] of [[BUILDING, 'backlog'], [BUILDING, 'needs-human'], [[...BUILDING, 'swarm/task-breakdown'], 'unstarted']]) {
    const c = fakeClient(item(labels, { id: 'i7', stage }), { files: { 's.md': '# Part\n\nBody.' }, others: [part] });
    await assert.rejects(run('create', ['COU-7', 's.md', '--sub'], c), BreakdownUsage);
    await assert.rejects(run('submit', ['COU-7', 'Two parts.', '--split=COU-50'], c), BreakdownUsage);
    assert.deepEqual(c.log, []);
  }
});

test('submit --split: the parts go to Todo together, the item says what they are and its lock comes off', async () => {
  const part = (key, extra = {}) => ({ ...item([]), key, number: key, id: key, title: `Part ${key}`, parent: 'i7', ...extra });
  const c = fakeClient(item(BUILDING, { id: 'i7', stage: 'started' }), { others: [part('COU-50'), part('COU-51'), part('COU-52', { stage: 'started' })] });
  const out = await run('submit', ['COU-7', 'Cut by folder.', '--split=COU-50,COU-51,COU-52'], c);
  assert.deepEqual(c.log, ['comment Cut by folder.', 'stage COU-50 unstarted', 'stage COU-51 unstarted', 'remove swarm/agent/claude-task-breakdown-1'], 'one already under way is left where it is');
  assert.deepEqual([out.split, out.released], [['COU-50', 'COU-51', 'COU-52'], ['COU-7']]);
  assert.deepEqual(c.item.labels.map((l) => l.name), ['swarm/focus', 'swarm/qa', 'area/app']);
});

test('submit --split: a key that is not a sub-issue of the item stops it before anything changes', async () => {
  const other = { ...item([]), key: 'COU-50', number: 'COU-50', id: 'COU-50', parent: 'i8' };
  const c = fakeClient(item(BUILDING, { id: 'i7', stage: 'started' }), { others: [other] });
  await assert.rejects(run('submit', ['COU-7', 'Parts.', '--split=COU-50,COU-99'], c), (e) => e instanceof BreakdownUsage && /COU-50, COU-99: not a sub-issue of COU-7/.test(e.message));
  await assert.rejects(run('submit', ['COU-7', 'Parts.', '--split='], c), BreakdownUsage);
  assert.deepEqual(c.log, []);
});
