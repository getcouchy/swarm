// node --test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TEAMS, appToken, linearClient, linearPlace, protocolName } from '../lib/linear.mjs';
import { LabelGroupTaken, PROVIDER_METHODS, assertProvider, currentKey, isKey, parsePairs, tracker } from '../lib/workitems.mjs';
import { bodyBlockers, closingIssues, linkedPulls, linkedTo, needsQA, partOfIssues, whyNotClaimable } from '../lib/rules.mjs';
import { claim, focusOf, next } from '../lib/tick.mjs';
import { findDesk, moveHandedOff, followPulls, readLinked, writeDesk } from '../sweep.mjs';
import { run } from '../lib/commands.mjs';

const STATES = [
  { id: 's-backlog', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
  // Before In Progress, so moving an item to `started` has to pass it over.
  { id: 's-human', name: 'Needs Human', type: 'started', position: 1.5 },
  { id: 's-doing', name: 'In Progress', type: 'started', position: 2 },
  { id: 's-review', name: 'In Review', type: 'started', position: 3 },
  { id: 's-done', name: 'Done', type: 'completed', position: 4 },
  { id: 's-cancel', name: 'Canceled', type: 'canceled', position: 5 },
];
const QA_STATE = { id: 's-qa', name: 'Review', type: 'started', position: 3.5 };

/**
 * An in-memory Linear behind fetch: one team, its states, the workspace's
 * labels, and issues with their comments, attachments, relations and label
 * history. It answers the queries linear.mjs sends, matched by what they ask.
 */
function fakeLinear({ issues = [], labels = [], states = STATES, relations = [], history = {}, limit = null } = {}) {
  const calls = [];
  const comments = {};
  const attachments = {};
  let left = limit;
  let n = 0;
  const byId = (id) => issues.find((i) => i.id === id || `COU-${i.number}` === id);
  const state = (id) => states.find((s) => s.id === id);
  const raw = (i) => ({
    id: i.id, identifier: `COU-${i.number}`, title: i.title, description: i.description, priority: i.priority,
    url: `https://linear.app/couchy/issue/COU-${i.number}/x`, createdAt: i.createdAt, updatedAt: i.updatedAt,
    state: (({ id, name, type }) => ({ id, name, type }))(state(i.stateId)),
    labels: { nodes: i.labelIds.map((id) => labels.find((l) => l.id === id)) },
    parent: i.parentId ? { id: i.parentId } : null,
    cycle: i.sprint ? { id: 'cy1', isActive: true } : i.cycleId ? { id: i.cycleId, isActive: false } : null,
    project: i.projectId ? { id: i.projectId } : null,
  });
  const rel = (i) => ({ identifier: `COU-${i.number}`, state: { type: state(i.stateId).type, name: state(i.stateId).name }, labels: { nodes: i.labelIds.map((id) => labels.find((l) => l.id === id)) } });
  const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  const ok = (data, headers = {}) => ({
    ok: true, status: 200, json: async () => ({ data }), text: async () => '', headers: { get: (h) => headers[h.toLowerCase()] ?? null },
  });
  const fetchImpl = async (url, { body } = {}) => {
    const { query, variables: v } = JSON.parse(body);
    const op = /^\s*(query|mutation)/.exec(query)?.[1] ?? 'query';
    const field = /\{\s*(\w+)/.exec(query)[1];
    calls.push(`${op} ${field}`);
    const headers = left == null ? {} : { 'x-ratelimit-requests-remaining': String(left), 'x-ratelimit-requests-reset': '100' };
    if (left != null) left -= 1;
    const reply = (data) => ok(data, headers);
    const touch = (i) => { i.updatedAt = `2026-11-18T00:00:${String(++n).padStart(2, '0')}Z`; return { issue: raw(i) }; };
    switch (field) {
      case 'organization': return reply({ organization: { urlKey: 'couchy' }, teams: { nodes: [{ id: 't1', key: 'COU', states: { nodes: states } }] } });
      case 'issueLabels': return reply({ issueLabels: page(labels.filter((l) => !v.name || l.name === v.name).map((l) => ({ team: null, isGroup: false, parent: null, retiredAt: null, ...l }))) });
      case 'issues': return reply({ issues: page(issues.map(raw)) });
      case 'issue': {
        const i = byId(v.id);
        if (!i) return { ok: true, status: 200, json: async () => ({ errors: [{ message: 'Entity not found: Issue' }] }), headers: { get: () => null } };
        if (/relations\(/.test(query)) {
          return reply({ issue: {
            relations: page(relations.filter((r) => r.from === i.id).map((r) => ({ type: r.type, relatedIssue: rel(byId(r.to)) }))),
            inverseRelations: page(relations.filter((r) => r.to === i.id).map((r) => ({ type: r.type, issue: rel(byId(r.from)) }))),
          } });
        }
        if (/comments\(/.test(query)) return reply({ issue: { comments: page(comments[i.id] ?? []) } });
        if (/attachments\(/.test(query)) return reply({ issue: { attachments: page(attachments[i.id] ?? []) } });
        if (/history\(/.test(query)) return reply({ issue: { history: page(history[i.id] ?? []) } });
        return reply({ issue: raw(i) });
      }
      case 'issueLabelCreate': {
        const group = labels.find((l) => l.id === v.input.parentId);
        const made = { id: `l-${group ? `${group.name}/` : ''}${v.input.name}`, ...v.input, ...(group ? { parent: { id: group.id, name: group.name } } : {}) };
        labels.push(made);
        return reply({ issueLabelCreate: { issueLabel: made } });
      }
      case 'issueAddLabel': {
        const i = byId(v.id);
        // A single-select group takes one child per issue, as Linear's does.
        const groupOf = (id) => labels.find((l) => l.id === id)?.parent?.id;
        const group = labels.find((l) => l.id === groupOf(v.label));
        if (group?.groupType === 'singleSelect' && i.labelIds.some((id) => groupOf(id) === group.id)) {
          return { ok: false, status: 400, json: async () => ({ errors: [{ message: 'labelIds not exclusive child labels', extensions: { userPresentableMessage: `Only one label in ${group.name} can be applied to an issue.` } }] }), headers: { get: () => null } };
        }
        i.labelIds.push(v.label);
        return reply({ issueAddLabel: touch(i) });
      }
      case 'issueRemoveLabel': { const i = byId(v.id); i.labelIds = i.labelIds.filter((l) => l !== v.label); return reply({ issueRemoveLabel: touch(i) }); }
      case 'issueUpdate': {
        const i = byId(v.id);
        const { stateId, title, description } = v.input;
        Object.assign(i, stateId ? { stateId } : {}, title ? { title } : {}, description != null ? { description } : {});
        return reply({ issueUpdate: touch(i) });
      }
      case 'issueCreate': {
        const { teamId, labelIds, parentId = null, priority = 0, stateId, title, description, projectId = null, cycleId = null } = v.input;
        assert.equal(teamId, 't1');
        const made = { id: `new${issues.length + 1}`, number: 900 + issues.length, title, description, priority, stateId, labelIds, parentId, projectId, cycleId, createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z' };
        issues.push(made);
        return reply({ issueCreate: { issue: raw(made) } });
      }
      case 'commentCreate': {
        const c = { id: `c${++n}`, body: v.input.body, createdAt: `2026-11-18T00:${String(n).padStart(2, '0')}:00Z`, updatedAt: 'x' };
        (comments[v.input.issueId] ??= []).push(c);
        return reply({ commentCreate: { comment: c } });
      }
      case 'commentUpdate': {
        const c = Object.values(comments).flat().find((x) => x.id === v.id);
        c.body = v.input.body;
        return reply({ commentUpdate: { success: true } });
      }
      case 'issueRelationCreate': relations.push({ from: v.input.issueId, to: v.input.relatedIssueId, type: v.input.type }); return reply({ issueRelationCreate: { success: true } });
      case 'attachmentCreate': {
        const a = { id: `a${++n}`, url: v.input.url, title: v.input.title, metadata: v.input.metadata ?? {} };
        (attachments[v.input.issueId] ??= []).push(a);
        return reply({ attachmentCreate: { success: true, attachment: { id: a.id } } });
      }
      case 'fileUpload': return reply({ fileUpload: { uploadFile: { uploadUrl: 'https://storage.example/put', assetUrl: `https://uploads.linear.app/w/${v.name}`, headers: [{ key: 'x-goog-meta', value: '1' }] } } });
      default: throw new Error(`fake Linear: no ${field}`);
    }
  };
  return { calls, comments, attachments, issues, labels, relations, fetchImpl };
}

/** An issue as the fake holds it: COU-<seq>, in Todo, no labels. */
const item = (seq, extra = {}) => ({
  id: `i${seq}`, number: seq, title: `Item ${seq}`, description: '', priority: 0, stateId: 's-todo', labelIds: [], parentId: null,
  createdAt: `2026-11-0${(seq % 9) + 1}T00:00:00Z`, updatedAt: '2026-11-10T00:00:00Z', ...extra,
});
const MAP = { 'COUCHYUX-1': 'COU-1', 'getcouchy/couchy#1680': 'COU-2', 'getcouchy/couchy#1700': 'COU-3', 'getcouchy/couchy-agent#5': 'COU-2' };
const client = (fake, more = {}) => linearClient({
  auth: { get: async () => 'k' }, team: 'COU', repo: 'getcouchy/couchy', map: MAP,
  fetchImpl: fake.fetchImpl, sleep: async () => {}, ...more,
});
const t = (gh, provider) => tracker(gh, provider, { map: MAP });
const labelNamesOf = (i) => i.labels.map((l) => l.name);

test('the provider has every method of the interface', () => {
  const p = client(fakeLinear());
  assert.equal(assertProvider(p), p);
  assert.deepEqual(PROVIDER_METHODS.filter((m) => typeof p[m] !== 'function'), []);
  assert.throws(() => assertProvider({ name: 'half', repo: 'x', all() {} }), /lacks owns, get/);
});

test('keys, teams and moved keys', () => {
  assert.ok(isKey('COU-12'));
  assert.ok(isKey('COUCHYUX-12'));
  assert.ok(!isKey(12));
  assert.ok(!isKey('#12'));
  assert.equal(parsePairs(DEFAULT_TEAMS).get('getcouchy/agent-runner'), 'COU');
  assert.equal(currentKey('COUCHYUX-1', MAP), 'COU-1');
  assert.equal(currentKey('COU-7', MAP), 'COU-7');
  const p = client(fakeLinear());
  assert.ok(p.owns('COU-3') && !p.owns('COUCHYUX-3'));
  assert.ok(t({ repo: 'getcouchy/couchy' }, p).items.owns('COUCHYUX-1'), 'an old key is still this tracker\'s');
});

test('an issue is shaped like an issue: key, stage, labels, repository, sprint and what it used to be called', async () => {
  const fake = fakeLinear({
    labels: [{ id: 'l1', name: 'swarm/focus' }, { id: 'l2', name: 'repo/couchy-agent' }],
    issues: [item(1, { labelIds: ['l1'], priority: 2 }), item(2), item(3, { labelIds: ['l2'] }), item(4, { stateId: 's-done' })],
  });
  const items = t({ repo: 'getcouchy/couchy' }, client(fake));
  const open = await items.openIssues();
  assert.deepEqual(open.map((i) => i.number), ['COU-1', 'COU-2'], 'only this repository\'s open items');
  const [one, two] = open;
  assert.deepEqual([one.stage, one.state, one.labels, one.priority], ['unstarted', 'open', [{ name: 'swarm/focus' }], 'high']);
  assert.deepEqual(one.aliases, ['COUCHYUX-1']);
  assert.deepEqual(two.aliases, ['getcouchy/couchy#1680', 1680, 'getcouchy/couchy-agent#5'], 'a GitHub number counts only in its own repository');
  assert.equal(one.html_url, 'https://linear.app/couchy/issue/COU-1/x');
  const agent = t({ repo: 'getcouchy/couchy-agent' }, client(fake, { repo: 'getcouchy/couchy-agent', defaultRepo: 'getcouchy/couchy' }));
  assert.deepEqual((await agent.openIssues()).map((i) => i.number), ['COU-3']);
  assert.equal((await items.findIssue(1680)).number, 'COU-2');
  assert.equal((await items.findIssue('COUCHYUX-1')).number, 'COU-1');
  assert.equal(await items.issue('COU-99'), null);
});

test('the current cycle is in focus, beside the label', async () => {
  const fake = fakeLinear({ labels: [{ id: 'l1', name: 'swarm/focus' }], issues: [item(1, { labelIds: ['l1'] }), item(2, { sprint: true }), item(3)] });
  assert.deepEqual((await t({ repo: 'getcouchy/couchy' }, client(fake)).openIssues(['swarm/focus'])).map((i) => i.number), ['COU-1', 'COU-2']);
});

test('labels: one added or removed at a time, created when new, removed under either name', async () => {
  const fake = fakeLinear({ labels: [{ id: 'l1', name: 'area/app' }, { id: 'l-old', name: 'agent/codex' }], issues: [item(1, { labelIds: ['l1', 'l-old'] })] });
  const items = t({ repo: 'getcouchy/couchy' }, client(fake));
  await items.addLabel('COU-1', 'swarm/agent/codex');
  assert.deepEqual(fake.issues[0].labelIds, ['l1', 'l-old', 'l-swarm/agent/codex']);
  assert.equal(fake.labels.at(-1).color, '#5319e7');
  await items.addLabel('COUCHYUX-1', 'swarm/agent/codex');
  assert.equal(fake.calls.filter((c) => c === 'mutation issueAddLabel').length, 1, 'already on: no write');
  await items.removeLabel('COU-1', 'swarm/agent/codex');
  assert.deepEqual(fake.issues[0].labelIds, ['l1'], 'and its name from before the swarm/ prefix');
});

test('the rate limit is waited out, not failed', async () => {
  const fake = fakeLinear({ issues: [item(1)], limit: 1 });
  const waits = [];
  await t({ repo: 'getcouchy/couchy' }, client(fake, { sleep: async (ms) => { waits.push(ms); }, now: () => 0 })).openIssues();
  assert.ok(waits.length > 0, 'waits once the key has one request left');
});

test('a 401 renews the app token once; client credentials are cached until a day before they expire', async () => {
  const fake = fakeLinear({ issues: [item(1)] });
  let first = true;
  const fetchImpl = async (url, opts) => {
    if (first) { first = false; return { ok: false, status: 401, json: async () => ({}), headers: { get: () => null } }; }
    return fake.fetchImpl(url, opts);
  };
  let renewed = 0;
  await t({ repo: 'getcouchy/couchy' }, client(fake, { fetchImpl, auth: { get: async () => 'Bearer a', renew: async () => { renewed++; } } })).openIssues();
  assert.equal(renewed, 1);

  const minted = [];
  const tokenFetch = async (url, { body }) => {
    minted.push(new URLSearchParams(body).get('grant_type'));
    return { ok: true, json: async () => ({ access_token: `tok${minted.length}`, expires_in: 2_592_000 }) };
  };
  const { mkdtempSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(`${tmpdir()}/linear-`);
  chmodSync(dir, 0o700);
  const file = `${dir}/token.json`;
  assert.equal(await appToken({ clientId: 'c', clientSecret: 's', file, fetchImpl: tokenFetch }).get(), 'tok1');
  assert.equal(await appToken({ clientId: 'c', clientSecret: 's', file, fetchImpl: tokenFetch }).get(), 'tok1', 'the next command reuses it');
  assert.equal(await appToken({ clientId: 'c', clientSecret: 's', file, fetchImpl: tokenFetch, now: () => Date.now() + 29.5 * 86_400_000 }).get(), 'tok2', 'within a day of expiry: a new one');
  assert.deepEqual(minted, ['client_credentials', 'client_credentials']);
});

test('blockers: relations and the description, by key, old key or the GitHub number an item came from', async () => {
  const fake = fakeLinear({
    issues: [
      item(1, { description: 'Blocked by COU-4, COUCHYUX-1, #1700 and #1680. Blocks COU-5.' }),
      item(2), item(3, { stateId: 's-done' }), item(4), item(5), item(6), item(7, { stateId: 's-done' }),
    ],
    relations: [{ from: 'i6', to: 'i1', type: 'blocks' }, { from: 'i7', to: 'i1', type: 'blocks' }, { from: 'i5', to: 'i1', type: 'related' }],
  });
  const items = t({ repo: 'getcouchy/couchy' }, client(fake));
  const [one] = await items.openIssues();
  assert.deepEqual(await items.blockers(one), ['COU-4', 'COU-2', 'COU-6'], 'itself, a done item and a related one block nothing');
});

test('blocking relations name the open items that wait, read once with the blockers', async () => {
  const fake = fakeLinear({
    issues: [item(1, { priority: 1 }), item(2), item(3, { stateId: 's-done' })],
    relations: [{ from: 'i1', to: 'i2', type: 'blocks' }, { from: 'i1', to: 'i3', type: 'blocks' }],
  });
  const items = t({ repo: 'getcouchy/couchy' }, client(fake));
  const [one] = await items.openIssues();
  assert.equal(one.priority, 'urgent');
  assert.deepEqual(await items.blocking(one), ['COU-2']);
  await items.blockers(one);
  assert.equal(fake.calls.filter((c) => c === 'query issue').length, 1);
});

test('a PR names a work item by key, old key, or the GitHub issue it was copied from', async () => {
  assert.deepEqual(closingIssues('Closes COU-12 and #4. Fixes flaky-2.'), ['COU-12', 4]);
  assert.deepEqual(partOfIssues('Part of COUCHYUX-7 (2 of 3)'), ['COUCHYUX-7']);
  const linked = linkedPulls([{ number: 50, body: 'Closes #1680' }, { number: 51, body: 'Part of COUCHYUX-1' }, { number: 52, body: 'Part of COU-1' }]);
  const one = { number: 'COU-1', aliases: ['COUCHYUX-1', 'getcouchy/couchy#1680', 1680], stage: 'unstarted', state: 'open', labels: [] };
  assert.deepEqual(linkedTo(linked, one).map((p) => p.number).sort(), [50, 51, 52]);
  assert.match(whyNotClaimable(one, { linked }), /PR #5[12]/);
  const sprint = { number: 'COU-9', labels: [] };
  const f = await focusOf({ openIssues: async () => [sprint], subIssues: async () => [], blockers: async (i) => (i === sprint ? ['#1680'] : []) }, [sprint, one]);
  assert.equal(f.of(one), 'COU-9');
});

test('tracker: work items go to Linear, pull requests to GitHub; a claimed Todo item moves to In Progress', async () => {
  const fake = fakeLinear({ issues: [item(1)] });
  const log = [];
  const gh = {
    repo: 'getcouchy/couchy',
    issue: async (n) => ({ number: n, labels: [], pull_request: {} }),
    addLabel: async (n, name) => log.push(`gh add ${n} ${name}`),
    removeLabel: async () => {},
  };
  const items = t(gh, client(fake));
  assert.equal(await claim(items, 'COU-1', 'codex'), true);
  assert.equal(fake.issues[0].stateId, 's-doing', 'the first started state by position, not In Review');
  await items.addLabel(57, 'swarm/agent/codex');
  assert.deepEqual(log, ['gh add 57 swarm/agent/codex']);
});

test('commands take a key, new or old; the event names the item by repository, number and key', async () => {
  const fake = fakeLinear({ issues: [item(12), item(1)] });
  const gh = { repo: 'getcouchy/couchy', rateLimitRemaining: () => 10 };
  const { out, event } = await run('needs-human', ['COU-12', 'Which', 'one?'], { clients: [t(gh, client(fake))], me: 'codex' });
  assert.deepEqual([out.commented, out.stage, out.label], [true, 'needs-human', undefined], 'a work item goes to Needs Human, unlabelled');
  assert.deepEqual([fake.issues[0].stateId, fake.issues[0].labelIds], ['s-human', []]);
  assert.match(fake.comments.i12[0].body, /Which one\?/);
  const line = await event();
  assert.deepEqual([line.repo, line.number, line.type, line.key], ['getcouchy/couchy', 12, 'issue', 'COU-12']);
  const old = await run('needs-human', ['COUCHYUX-1', 'Old', 'key?'], { clients: [t(gh, client(fake))], me: 'codex' });
  assert.equal(old.out.stage, 'needs-human');
  assert.match(fake.comments.i1[0].body, /Old key\?/);
});

test('sweep: work items follow their PRs, each link added once; Backlog stays Backlog', async () => {
  const fake = fakeLinear({ issues: [item(1, { stateId: 's-todo' }), item(2, { stateId: 's-doing' }), item(3, { stateId: 's-backlog' })] });
  const now = Date.parse('2026-11-16T12:00:00Z');
  const gh = t({
    repo: 'getcouchy/couchy',
    closedPulls: async () => [
      { number: 60, title: 'Old', body: 'Closes #1680', merged_at: '2026-11-16T10:00:00Z', html_url: 'https://github.com/x/60' },
      { number: 61, title: 'Shut', body: 'Closes COU-1', merged_at: null, html_url: 'https://github.com/x/61' },
    ],
  }, client(fake));
  const pulls = [
    { number: 57, title: 'Work', body: 'Part of COUCHYUX-1', html_url: 'https://github.com/x/57' },
    { number: 58, title: 'Early', body: 'Closes COU-3', html_url: 'https://github.com/x/58' },
  ];
  const { lines, linked } = await followPulls(gh, { pulls, now });
  assert.deepEqual(lines, ['COU-1 is In Progress: PR #57 is open for it.', 'COU-2 is Done: PR #60 merged.']);
  assert.deepEqual(fake.issues.map((i) => i.stateId), ['s-doing', 's-done', 's-backlog'], 'an open PR does not take an item out of Backlog');
  assert.deepEqual(fake.attachments.i3.map((a) => a.url), ['https://github.com/x/58']);
  assert.deepEqual(fake.attachments.i1.map((a) => [a.url, a.title]), [['https://github.com/x/57', 'PR #57: Work']]);
  const again = await followPulls(gh, { pulls, stored: `<!-- swarm-linked: ${JSON.stringify(linked)} -->`, now });
  assert.deepEqual(again.lines, []);
  assert.equal(fake.attachments.i1.length, 1);
  assert.equal(await client(fake).addLink('COU-1', 'https://github.com/x/57', 'again'), false, 'a link already there is not added twice');
  assert.deepEqual(readLinked('nothing'), []);
});

test('QA: work that touches what people use waits there for the owner; backend work goes to Done', () => {
  const it = (...names) => ({ labels: names.map((name) => ({ name })) });
  assert.ok(needsQA(it('area/app', 'platform/web')));
  assert.ok(!needsQA(it('area/api', 'effort/small')));
  assert.ok(needsQA(it('area/ci', 'swarm/qa')));
});

test('Review state: no agent takes an item there and it blocks nothing; merges move it once, so a failed QA stays in Todo', async () => {
  const fake = fakeLinear({
    states: [...STATES, QA_STATE],
    labels: [{ id: 'l-app', name: 'area/app' }, { id: 'l-api', name: 'area/api' }],
    issues: [
      item(1, { stateId: 's-doing', labelIds: ['l-app'] }),
      item(2, { stateId: 's-doing', labelIds: ['l-api'] }),
      item(3, { stateId: 's-qa' }),
      item(4, { description: 'Blocked by COU-3.' }),
      item(5),
    ],
  });
  const items = t({ repo: 'getcouchy/couchy' }, client(fake));
  const open = await items.openIssues();
  assert.deepEqual(open.map((i) => i.number), ['COU-1', 'COU-2', 'COU-4', 'COU-5'], 'an item in Review is not open work');
  assert.deepEqual((await items.inQA()).map((i) => [i.number, i.stage]), [['COU-3', 'qa']]);
  assert.deepEqual(await items.blockers(open[2]), [], 'an item in Review blocks nothing');
  assert.equal(await items.setStage('COU-5', 'started'), 'started');
  assert.equal(fake.issues[4].stateId, 's-doing', 'a claim moves to In Progress, never to Review');

  const now = Date.parse('2026-11-16T12:00:00Z');
  const merged = (number, body) => ({ number, title: `PR ${number}`, body, merged_at: '2026-11-16T10:00:00Z', html_url: `https://github.com/x/${number}` });
  const gh = t({ repo: 'getcouchy/couchy', closedPulls: async () => [merged(60, 'Closes COU-1'), merged(61, 'Closes COU-2')] }, client(fake));
  const first = await followPulls(gh, { pulls: [], now });
  assert.deepEqual(first.lines, ['COU-1 is in Review: PR #60 merged.', 'COU-2 is Done: PR #61 merged.']);
  assert.deepEqual([fake.issues[0].stateId, fake.issues[1].stateId], ['s-qa', 's-done']);
  fake.issues[0].stateId = 's-todo';
  const stored = `<!-- swarm-linked: ${JSON.stringify(first.linked)} -->`;
  const again = await followPulls(t({ repo: 'getcouchy/couchy', closedPulls: async () => [merged(60, 'Closes COU-1')] }, client(fake)), { pulls: [], stored, now });
  assert.deepEqual(again.lines, []);
  assert.equal(fake.issues[0].stateId, 's-todo');

  const noQa = t({ repo: 'getcouchy/couchy' }, client(fakeLinear({ issues: [item(1)] })));
  assert.equal(await noQa.setStage('COU-1', 'qa'), 'completed', 'a team with no Review state sends it to Done');
});

test('Review state: a technical design there has not merged, so it still blocks; no tick takes it', async () => {
  const fake = fakeLinear({
    states: [...STATES, QA_STATE],
    labels: [{ id: 'l-td', name: 'tech-design', parent: { name: 'swarm' } }],
    issues: [item(1, { stateId: 's-qa', labelIds: ['l-td'] }), item(2, { description: 'Blocked by COU-1.' }), item(3)],
    relations: [{ from: 'i1', to: 'i3', type: 'blocks' }],
  });
  const items = t({ repo: 'getcouchy/couchy' }, client(fake));
  const [design, named, related] = await items.openIssues();
  assert.deepEqual([design.number, design.stage], ['COU-1', 'qa']);
  assert.deepEqual([await items.blockers(named), await items.blockers(related)], [['COU-1'], ['COU-1']]);
  assert.deepEqual((await items.inQA()).map((i) => i.number), ['COU-1'], 'the desk lists it for the owner');
  assert.match(whyNotClaimable(design, {}), /not ready: in qa/);
});

test('desk: the markers live in one comment the sweep edits, so the next run remembers what it said', async () => {
  const fake = fakeLinear({ issues: [] });
  const overdue = [{ section: 'Needs you', key: 'human:COU-7', line: 'COU-7 Item 7' }];
  await writeDesk(t({ repo: 'getcouchy/couchy' }, client(fake)), { desk: null, overdue, fixed: [], linked: ['COU-1<57'], now: Date.parse('2026-11-16T12:00:00Z') });
  const [desk] = fake.issues;
  assert.equal(desk.stateId, 's-backlog');
  assert.doesNotMatch(desk.description, /<!--/, 'the description is for people; the markers go in a comment');
  const posted = () => fake.comments[desk.id].map((c) => c.body);
  assert.equal(posted().length, 2, 'the state, then what is newly overdue');
  assert.match(posted()[0], /<!-- agent-desk-state: \["human:COU-7"\] -->/);
  assert.match(posted()[0], /<!-- swarm-linked: \["COU-1<57"\] -->/);

  const provider = client(fake);
  const again = t({ repo: 'getcouchy/couchy' }, provider);
  const key = `COU-${desk.number}`;
  const stateComment = (await again.comments(key)).find((c) => /agent-desk-state/.test(c.body));
  await writeDesk(again, { desk: await again.issue(key), stateComment, overdue, fixed: [], now: Date.parse('2026-11-16T12:10:00Z') });
  assert.equal(posted().length, 2, 'edited in place; no second "newly overdue"');
  assert.deepEqual(readLinked(posted()[0]), []);
});

test('desk: the sweep of a repository other than the team\'s first makes the desk in that repository, where its next run finds it', async () => {
  const fake = fakeLinear({ issues: [] });
  const agent = () => t({ repo: 'getcouchy/couchy-agent' }, client(fake, { repo: 'getcouchy/couchy-agent', defaultRepo: 'getcouchy/couchy' }));
  await writeDesk(agent(), { desk: null, overdue: [], fixed: [], now: Date.parse('2026-11-16T12:00:00Z') });
  const next = agent();
  assert.equal((await findDesk(next, await next.openIssues()))?.title, 'Agent desk');
  const couchy = t({ repo: 'getcouchy/couchy' }, client(fake));
  assert.equal(await findDesk(couchy, await couchy.openIssues()), null, 'not getcouchy/couchy\'s desk');
});

test('a work item made for a repository other than the team\'s first carries that repository\'s label', async () => {
  const fake = fakeLinear({ issues: [], labels: [{ id: 'l-runner', name: 'repo/agent-runner' }] });
  const agent = t({ repo: 'getcouchy/couchy-agent' }, client(fake, { repo: 'getcouchy/couchy-agent', defaultRepo: 'getcouchy/couchy' }));
  const made = await agent.createIssue('Agent work', 'Body.', ['swarm/focus']);
  assert.deepEqual([made.repo, labelNamesOf(made)], ['getcouchy/couchy-agent', ['swarm/focus', 'repo/couchy-agent']]);
  const named = await agent.createIssue('Runner work', 'Body.', ['repo/agent-runner']);
  assert.deepEqual([named.repo, labelNamesOf(named)], ['getcouchy/agent-runner', ['repo/agent-runner']], 'a repository named by the caller stands');
  const couchy = await t({ repo: 'getcouchy/couchy' }, client(fake)).createIssue('Couchy work', 'Body.');
  assert.deepEqual([couchy.repo, labelNamesOf(couchy)], ['getcouchy/couchy', []], 'the team\'s first repository needs no label');
});

test('events: label history reads as GitHub\'s issue events', async () => {
  const fake = fakeLinear({
    issues: [item(1)],
    history: { i1: [
      { createdAt: '2026-11-17T01:00:00Z', addedLabels: [{ name: 'swarm/agent/codex' }], removedLabels: [] },
      { createdAt: '2026-11-17T00:00:00Z', addedLabels: [], removedLabels: [{ name: 'swarm/hold' }] },
      { createdAt: '2026-11-17T02:00:00Z', addedLabels: null, removedLabels: null },
    ] },
  });
  assert.deepEqual(await t({ repo: 'getcouchy/couchy' }, client(fake)).events('COU-1'), [
    { event: 'unlabeled', label: { name: 'swarm/hold' }, created_at: '2026-11-17T00:00:00Z' },
    { event: 'labeled', label: { name: 'swarm/agent/codex' }, created_at: '2026-11-17T01:00:00Z' },
  ]);
});

test('events: a work item carries its title from what the tracker read, a PR its own; the line asks Linear nothing', async () => {
  const fake = fakeLinear({ issues: [item(12, { sprint: true }), item(13, { labelIds: ['l-agent'] })], labels: [{ id: 'l-agent', name: 'swarm/agent/codex' }] });
  const pulls = [{ number: 57, title: 'Fix login', labels: [{ name: 'swarm/pr' }, { name: 'swarm/agent/codex' }] }];
  const gh = {
    repo: 'getcouchy/couchy',
    rateLimitRemaining: () => 10,
    openPulls: async () => pulls,
    requiredChecks: async () => [],
    issue: async (n) => ({ ...pulls.find((p) => p.number === n), pull_request: {} }),
    removeLabel: async () => {},
  };
  const line = async (cmd, args) => {
    const { event } = await run(cmd, args, { clients: [t(gh, client(fake))], me: 'codex', ceiling: 45, entry: 'agent.mjs' });
    const before = fake.calls.length;
    const { v, at, rateLimitRemaining, ...rest } = await event();
    assert.equal(fake.calls.length, before, `${cmd}: no Linear call for its line`);
    return rest;
  };
  const twelve = { repo: 'getcouchy/couchy', number: 12, type: 'issue', key: 'COU-12', title: 'Item 12' };
  const thirteen = { repo: 'getcouchy/couchy', number: 13, type: 'issue', key: 'COU-13', title: 'Item 13' };
  const pr = { repo: 'getcouchy/couchy', number: 57, type: 'pull', title: 'Fix login' };
  assert.deepEqual(await line('claim', ['COU-12']), { cmd: 'claim', ...twelve, claimed: [twelve] });
  assert.deepEqual(await line('release', ['COU-12']), { cmd: 'release', ...twelve, released: [twelve] });
  assert.deepEqual(await line('finish', []), { cmd: 'finish', released: [thirteen, pr] });
  pulls.length = 0;
  fake.issues.splice(1);
  fake.issues[0].labelIds = [];
  fake.issues[0].stateId = 's-todo';
  assert.deepEqual(await line('next', []), { cmd: 'next', job: 'implement', ...twelve, claimed: [twelve] });
});

test('descriptions are Markdown as Linear stores them: blockers read straight from them', () => {
  assert.deepEqual(bodyBlockers('### Scope\n\nBlocked by COU-3 & #5.').map((b) => b.key ?? b.number), ['COU-3', 5]);
});

test('task breakdown: child items are made in Backlog under their parent; relations; files upload, then attach', async () => {
  const fake = fakeLinear({ issues: [item(1, { labelIds: ['lg'] }), item(2)], labels: [{ id: 'lg', name: 'groom', parent: { id: 'g-swarm', name: 'swarm' } }] });
  const puts = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url === 'https://storage.example/put') {
      puts.push([opts.method, opts.headers['Content-Type'], opts.headers['x-goog-meta'], opts.body.length]);
      return { ok: true, status: 200, text: async () => '' };
    }
    return fake.fetchImpl(url, opts);
  };
  const items = t({ repo: 'getcouchy/couchy' }, client(fake, { fetchImpl }));
  assert.equal(await claim(items, 'COU-1', 'claude-task-breakdown-1'), true);
  assert.equal(fake.issues[0].stateId, 's-todo', 'breaking down is not building');

  const child = await items.createIssue('Slice one', '### Scope\n\n- this', ['swarm/focus'], { parent: 'COUCHYUX-1', priority: 'high' });
  const made = fake.issues.at(-1);
  assert.deepEqual([made.stateId, made.parentId, made.priority, made.description], ['s-backlog', 'i1', 2, '### Scope\n\n- this']);
  await items.relate(child.key, 'blocked_by', ['COU-2']);
  assert.deepEqual(fake.relations.at(-1), { from: 'i2', to: made.id, type: 'blocks' });
  assert.deepEqual(await items.blockers(await items.issue(child.key)), ['COU-2']);

  assert.deepEqual(await items.attach('COU-1', { name: 'board.png', type: 'image/png', bytes: Buffer.from('png') }), { id: fake.attachments.i1[0].id, name: 'board.png' });
  assert.deepEqual(puts, [['PUT', 'image/png', '1', 3]], 'the signed PUT carries the headers Linear handed out');
  assert.deepEqual((await items.attachments('COU-1')).map((a) => [a.name, a.type, a.size]), [['board.png', 'image/png', 3]]);
  await items.addLink('COU-1', 'https://github.com/x/1', 'PR #1');
  assert.equal((await items.attachments('COU-1')).length, 1, 'links are not uploads');
});

test('task breakdown: a slice goes in the project and the cycle of the item it came from, with no parent', async () => {
  const fake = fakeLinear({
    issues: [item(1, { projectId: 'p1', sprint: true, labelIds: ['lw', 'la'] }), item(2, { cycleId: 'cy0' })],
    labels: [{ id: 'lw', name: 'web', parent: { id: 'g-platform', name: 'platform' } }, { id: 'la', name: 'app', parent: { id: 'g-area', name: 'area' }, retiredAt: '2026-11-20T00:00:00Z' }],
  });
  const items = t({ repo: 'getcouchy/couchy' }, client(fake));
  const from = await items.issue('COU-1');
  assert.deepEqual([from.project, from.cycle, from.sprint], ['p1', 'cy1', true]);
  assert.deepEqual(from.labels, [{ name: 'platform/web' }, { name: 'area/app', retired: true }], 'a retired label is still read, and known as retired');
  const past = await items.issue('COU-2');
  assert.deepEqual([past.project, past.cycle, past.sprint], [null, 'cy0', false]);

  const slice = await items.createIssue('Slice one', 'Body.', [], { priority: 'high', project: from.project, cycle: from.cycle });
  const made = fake.issues.at(-1);
  assert.deepEqual([made.projectId, made.cycleId, made.parentId, made.stateId], ['p1', 'cy1', null, 's-backlog']);
  assert.deepEqual([slice.project, slice.parent], ['p1', null]);
});

test('dry run: reads happen, writes are logged and not made', async () => {
  const fake = fakeLinear({ issues: [item(1)] });
  const logged = [];
  const items = t({ repo: 'getcouchy/couchy' }, client(fake, { dryRun: true, log: (l) => logged.push(l) }));
  await items.comment('COU-1', 'hi');
  await items.setStage('COU-1', 'started');
  assert.deepEqual(fake.calls.filter((c) => c.startsWith('mutation')), []);
  assert.equal(logged.length, 2);
  assert.equal(fake.issues[0].stateId, 's-todo');
});

test('an item back from QA: the job says what shipped it and what the owner wrote since, so the agent fixes only that', async () => {
  const fake = fakeLinear({ issues: [item(5, { sprint: true }), item(6, { sprint: true }), item(7, { sprint: true })] });
  const p = client(fake);
  // The sweep linked the PRs it followed; COU-5's closing PR merged, COU-6's PR was only part of it.
  await p.addLink('COU-5', 'https://github.com/getcouchy/couchy/pull/60', 'PR #60: Couch rail');
  await p.addLink('COU-5', 'https://github.com/getcouchy/other/pull/61', 'elsewhere');
  await p.addLink('COU-6', 'https://github.com/getcouchy/couchy/pull/62', 'PR #62: part');
  fake.comments.i5 = [
    { id: 'c1', body: 'Before the merge.', createdAt: '2026-11-17T00:00:00Z', updatedAt: 'x' },
    { id: 'c2', body: 'QA failed: criterion 3, the count shifts the tab width.', createdAt: '2026-11-18T10:00:00Z', updatedAt: 'x' },
    { id: 'c3', body: 'Released by claude-1\n\n<!-- agent: claude-1 -->', createdAt: '2026-11-18T11:00:00Z', updatedAt: 'x' },
  ];
  const pulls = {
    60: { number: 60, merged_at: '2026-11-17T12:00:00Z', body: 'Closes COUCHYUX-1', html_url: 'https://github.com/getcouchy/couchy/pull/60' },
    62: { number: 62, merged_at: '2026-11-17T12:00:00Z', body: 'Part of COU-6', html_url: 'https://github.com/getcouchy/couchy/pull/62' },
  };
  const asked = [];
  const gh = {
    repo: 'getcouchy/couchy', openPulls: async () => [], requiredChecks: async () => [],
    pull: async (n) => { asked.push(n); return pulls[n]; },
  };
  // COUCHYUX-1 is COU-1 in MAP; give COU-5 that name too, as moved.json would.
  const map = { ...MAP, 'COUCHYUX-1': 'COU-5' };
  const t5 = tracker(gh, client(fake, { map }), { map });
  const job = await next(t5, { me: 'codex', doClaim: false });
  assert.equal(job.issue, 'COU-5');
  assert.deepEqual(job.returned.pulls, [{ pull: 60, url: 'https://github.com/getcouchy/couchy/pull/60', merged_at: '2026-11-17T12:00:00Z' }]);
  assert.deepEqual(job.returned.feedback.map((f) => f.text), ['QA failed: criterion 3, the count shifts the tab width.'], 'only people\'s comments since the merge');
  assert.match(job.returned.how, /Fix only that.*Closes COU-5/);
  assert.deepEqual(asked, [60], 'a PR in another repository is not asked about');

  // With no word on what failed, the agent asks rather than guesses.
  fake.comments.i5 = fake.comments.i5.filter((c) => c.id !== 'c2');
  const again = await next(tracker(gh, client(fake, { map }), { map }), { me: 'codex', doClaim: false });
  assert.match(again.returned.how, /needs-human COU-5/);

  // A PR that is only part of an item, or none at all: an ordinary job.
  fake.issues.splice(0, 1);
  const six = await next(tracker(gh, client(fake, { map }), { map }), { me: 'codex', doClaim: false });
  assert.equal(six.issue, 'COU-6');
  assert.equal(six.returned, undefined);
});

test('links: what is linked to an item, its uploads aside', async () => {
  const fake = fakeLinear({ issues: [item(1)] });
  const p = client(fake);
  await p.addLink('COU-1', 'https://github.com/getcouchy/couchy/pull/60', 'PR #60: x');
  fake.attachments.i1.push({ id: 'up', url: 'https://uploads.linear.app/w/board.png', title: 'board.png', metadata: {} });
  assert.deepEqual(await p.links('COU-1'), [{ url: 'https://github.com/getcouchy/couchy/pull/60', title: 'PR #60: x' }]);
});

// Linear's label groups as the couchy workspace has them: locks in
// `swarm-agent` and repositories in `repo` take one label each; `swarm` takes several.
const GROUPED = [
  { id: 'g-agent', name: 'swarm-agent', isGroup: true, groupType: 'singleSelect' },
  { id: 'g-swarm', name: 'swarm', isGroup: true, groupType: 'multiSelect' },
  { id: 'g-repo', name: 'repo', isGroup: true, groupType: 'singleSelect' },
  { id: 'g-platform', name: 'platform', isGroup: true, groupType: 'singleSelect' },
  { id: 'l-claude-1', name: 'claude-1', parent: { id: 'g-agent', name: 'swarm-agent' } },
  { id: 'l-human', name: 'needs-human', parent: { id: 'g-swarm', name: 'swarm' } },
  { id: 'l-sim', name: 'needs-ios-sim', parent: { id: 'g-swarm', name: 'swarm' } },
  { id: 'l-blocked', name: 'blocked', parent: { id: 'g-swarm', name: 'swarm' } },
  { id: 'l-blocked-flat', name: 'swarm/blocked' },
  { id: 'l-runner', name: 'agent-runner', parent: { id: 'g-repo', name: 'repo' } },
  { id: 'l-ios', name: 'platform/ios', parent: { id: 'g-platform', name: 'platform' } },
  { id: 'l-desk-old', name: 'swarm/desk', retiredAt: '2026-11-20T00:00:00Z' },
];
const grouped = (more = {}) => fakeLinear({ labels: GROUPED.map((l) => ({ ...l })), ...more });

test('label groups: a child reads as the protocol names it, and goes back to its group', () => {
  const as = (name, group) => protocolName({ name, parent: group ? { name: group } : null });
  assert.deepEqual([as('claude-1', 'swarm-agent'), as('needs-human', 'swarm'), as('needs-ios-sim', 'swarm'), as('blocked', 'swarm'),
    as('agent-runner', 'repo'), as('platform/ios', 'platform'), as('web', 'platform'), as('swarm/blocked')],
  ['swarm/agent/claude-1', 'swarm/needs-human', 'swarm/needs/ios-sim', 'swarm/blocked', 'repo/agent-runner', 'platform/ios', 'platform/web', 'swarm/blocked']);
  for (const name of ['swarm/agent/claude-1', 'swarm/needs-human', 'swarm/needs/ios-sim', 'swarm/qa', 'repo/ops']) {
    const { group, child } = linearPlace(name);
    assert.equal(as(child, group), name, `${name} round-trips`);
  }
  assert.equal(linearPlace('conflicts-with-main'), null);
});

test('label groups: items read grouped labels, the repo group routes them, new labels are made in their group', async () => {
  const fake = grouped({ issues: [item(1, { labelIds: ['l-runner', 'l-sim', 'l-human'] }), item(2, { labelIds: ['l-blocked', 'l-blocked-flat'] })] });
  const runner = linearClient({ auth: { get: async () => 'k' }, team: 'COU', repo: 'getcouchy/agent-runner', defaultRepo: 'getcouchy/couchy', map: MAP, fetchImpl: fake.fetchImpl, sleep: async () => {} });
  const [one] = (await t({ repo: 'getcouchy/agent-runner' }, runner).openIssues());
  assert.equal(one.number, 'COU-1', 'only the item the repo group gives this repository');
  assert.deepEqual(labelNamesOf(one), ['repo/agent-runner', 'swarm/needs/ios-sim', 'swarm/needs-human']);
  const items = t({ repo: 'getcouchy/couchy' }, client(fake));
  await items.addLabel('COU-2', 'swarm/agent/claude-5');
  assert.deepEqual(fake.labels.at(-1), { id: 'l-swarm-agent/claude-5', name: 'claude-5', parentId: 'g-agent', color: '#5319e7', parent: { id: 'g-agent', name: 'swarm-agent' } });
  await items.addLabel('COU-2', 'swarm/desk');
  assert.equal(fake.labels.at(-1).parentId, 'g-swarm', 'a retired label is not reused: swarm/desk is made in the swarm group');
  await items.removeLabel('COU-2', 'swarm/blocked');
  assert.deepEqual(fake.issues[1].labelIds, ['l-swarm-agent/claude-5', 'l-swarm/desk'], 'grouped and ungrouped swarm/blocked both come off');
});

test('label groups: a second agent\'s lock is refused, and that agent has lost the claim', async () => {
  const fake = grouped({ issues: [item(1, { labelIds: ['l-claude-1'] }), item(2)] });
  const items = t({ repo: 'getcouchy/couchy' }, client(fake));
  await assert.rejects(items.addLabel('COU-1', 'swarm/agent/claude-2'), (e) => e instanceof LabelGroupTaken && /Only one label in swarm-agent/.test(e.message));
  // As if claude-1's label landed between claude-2's read and its write.
  const racing = { ...items, issue: async (n) => (n === 'COU-1' ? { number: n, labels: [] } : items.issue(n)) };
  assert.equal(await claim(racing, 'COU-1', 'claude-2'), false);
  assert.equal(await claim(items, 'COU-2', 'claude-2'), true);
  assert.equal(fake.issues[1].stateId, 's-doing', 'In Progress, not Needs Human, though Needs Human comes first');
});

test('Needs Human: a work item waiting on a person; the sweep moves labelled ones there', async () => {
  const fake = grouped({ issues: [item(1, { labelIds: ['l-human'] }), item(2, { stateId: 's-human' }), item(3, { title: 'Agent desk', stateId: 's-backlog' })] });
  const items = t({ repo: 'getcouchy/couchy' }, client(fake));
  const two = await items.issue('COU-2');
  assert.deepEqual([two.stage, two.state], ['needs-human', 'open']);
  assert.match(whyNotClaimable(two, {}), /Needs Human/);
  const issues = await items.openIssues();
  const lines = await moveHandedOff(items, issues);
  assert.deepEqual(lines, ['COU-1: `swarm/needs-human` is now the Needs Human state.']);
  assert.deepEqual([fake.issues[0].stateId, fake.issues[0].labelIds], ['s-human', []]);
  assert.equal(issues[0].stage, 'needs-human', 'updated in place for the rest of the run');
  const desk = await findDesk(items, issues);
  assert.equal(desk.number, 'COU-3', 'found by its title when the label is gone');
  assert.deepEqual(labelNamesOf(await items.issue('COU-3')), ['swarm/desk']);
});

test('Needs Human: without that state the label stays, and the sweep says why', async () => {
  const fake = grouped({ states: STATES.filter((s) => s.id !== 's-human'), issues: [item(1, { labelIds: ['l-human'] })] });
  const items = t({ repo: 'getcouchy/couchy' }, client(fake));
  const [line] = await moveHandedOff(items, await items.openIssues());
  assert.match(line, /^COU-1 and the rest keep `swarm\/needs-human`: Linear team COU has no needs-human state/);
  assert.deepEqual([fake.issues[0].stateId, fake.issues[0].labelIds], ['s-todo', ['l-human']]);
});
