// node --test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShapeUsage, shapeCommand, titled } from './shape.mjs';

/** A work item's tracker, in memory: one item and what the commands did to it. */
function fakeClient(item, { comments = [], attachments = [], files = {} } = {}) {
  const log = [];
  const labels = () => item.labels.map((l) => l.name);
  return {
    log,
    item,
    files,
    issue: async () => structuredClone(item),
    comments: async () => comments,
    subIssues: async () => ['COU-9'],
    seen: (k) => (k === 'COU-9' ? { title: 'Child' } : null),
    blockers: async () => ['COU-2'],
    attachments: async () => attachments,
    attachmentUrl: async (key, id) => `https://uploads.linear.app/w/${id}/`,
    download: async (url) => ({ type: url.endsWith('/a1/') ? 'image/png' : 'image/jpeg', bytes: Buffer.from(url) }),
    comment: async (key, md) => log.push(`comment ${md.split('\n')[0]}`),
    editIssue: async (key, { body }) => { log.push(`describe ${body}`); },
    addLabel: async (key, name) => { log.push(`add ${name}`); if (!labels().includes(name)) item.labels.push({ name }); },
    removeLabel: async (key, name) => { log.push(`remove ${name}`); item.labels = item.labels.filter((l) => l.name !== name); },
    createIssue: async (title, body, ls, opts) => { log.push(`create ${title} [${ls}] under ${opts.parent} ${opts.priority}`); return { key: 'COU-50', html_url: 'u' }; },
    relate: async (key, kind, keys) => log.push(`relate ${key} ${kind} ${keys}`),
    attach: async (key, f) => { log.push(`attach ${f.name} ${f.type} ${f.bytes.length}`); return { id: 'x', name: f.name }; },
  };
}
const item = (labels = ['swarm/groom', 'swarm/agent/claude-shape-1'], extra = {}) => ({
  key: 'COU-7', number: 'COU-7', title: 'Seven', html_url: 'https://linear.app/couchy/issue/COU-7/seven', stage: 'backlog', priority: 'high',
  labels: labels.map((name) => ({ name })), parent: null, body: 'Old text.\n\n![Board](https://uploads.linear.app/w/b.png)', ...extra,
});
const me = 'claude-shape-1';
const run = (cmd, args, client, more = {}) => shapeCommand(cmd, args, { client, me, readFile: (f) => client.files[f], ...more });

test('show: the work item as Markdown, with its comments, children, blockers and attachments', async () => {
  const c = fakeClient(item(), { comments: [{ created_at: 't', body: 'Make it **smaller**.' }], attachments: [{ id: 'a1', name: 'board.png' }] });
  const out = await run('show', ['COU-7'], c);
  assert.equal(out.description, 'Old text.\n\n![Board](https://uploads.linear.app/w/b.png)');
  assert.deepEqual(out.comments, [{ at: 't', text: 'Make it **smaller**.' }]);
  assert.deepEqual(out.children, [{ key: 'COU-9', title: 'Child' }]);
  assert.deepEqual([out.blockers, out.attachments.map((a) => a.name)], [['COU-2'], ['board.png']]);
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
  const unlocked = fakeClient(item(['swarm/groom']), { files: { 'd.md': 'New.' } });
  await assert.rejects(run('describe', ['COU-7', 'd.md'], unlocked), (e) => e instanceof ShapeUsage && /claim it first/.test(e.message));
  const c = fakeClient(item(), { files: { 'd.md': '### Scope\n\n- New.' } });
  assert.deepEqual(await run('describe', ['COU-7', 'd.md'], c), { key: 'COU-7', described: true });
  assert.deepEqual(c.log, ['comment The description before claude-shape-1 rewrote it:', 'describe ### Scope\n\n- New.']);
});

test('create: a child in Backlog, marked shaped, titled by its heading, with its blockers; swarm labels are not the agent\'s to add', async () => {
  assert.deepEqual(titled('# Slice one\n\nBody.'), { title: 'Slice one', body: 'Body.' });
  assert.throws(() => titled('No heading'), ShapeUsage);
  const c = fakeClient(item(), { files: { 's.md': '# Slice one\n\n### Scope\n\n- this' } });
  const out = await run('create', ['COU-7', 's.md', '--labels=platform/web,swarm/focus', '--blocked-by=COU-2,COU-3', '--priority=high'], c);
  assert.deepEqual([out.created, out.labels], ['COU-50', ['swarm/shaped', 'platform/web']]);
  assert.deepEqual(c.log, ['create Slice one [swarm/shaped,platform/web] under COU-7 high', 'relate COU-50 blocked_by COU-2,COU-3']);
});

test('labels: product labels only; attach: known file types', async () => {
  const c = fakeClient(item(), { files: { 'b.png': Buffer.from('png!'), 'x.exe': Buffer.from('') } });
  assert.deepEqual(await run('labels', ['COU-7', '+platform/web', '-area/api'], c), { key: 'COU-7', added: ['platform/web'], removed: ['area/api'] });
  await assert.rejects(run('labels', ['COU-7', '-swarm/groom'], c), /own commands/);
  assert.deepEqual(await run('attach', ['COU-7', 'b.png'], c), { key: 'COU-7', attached: ['b.png'] });
  await assert.rejects(run('attach', ['COU-7', 'x.exe'], c), /attach takes/);
  assert.deepEqual(c.log, ['add platform/web', 'remove area/api', 'attach b.png image/png 4']);
});

test('shaped: the summary, then swarm/shaped in place of the request, and the lock comes off', async () => {
  const c = fakeClient(item(['swarm/design', 'swarm/groom', 'swarm/agent/claude-shape-1', 'platform/web']));
  await assert.rejects(run('shaped', ['COU-7'], c), /Usage/);
  assert.deepEqual(await run('shaped', ['COU-7', 'Spec in getcouchy/couchy-design#40.'], c), { key: 'COU-7', shaped: true, released: ['COU-7'] });
  assert.deepEqual(c.log, ['comment Spec in getcouchy/couchy-design#40.', 'add swarm/shaped', 'remove swarm/groom', 'remove swarm/design', 'remove swarm/agent/claude-shape-1']);
  assert.deepEqual(c.item.labels.map((l) => l.name), ['platform/web', 'swarm/shaped']);
});
