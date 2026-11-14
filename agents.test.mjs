// node --test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentFromLogin, agentOf, bodyBlockers, claimWinner, closingIssues, fixReasons, independentReviews, canonical, focus, lockLapsed, pullState, isReviewOnly, isSwarmPull, oldName, providers, linkedPulls, reviewedStatus, whyNotClaimable,
} from './rules.mjs';
import { client } from './github.mjs';
import { LABELS, countLabelled, deskBody, migrateLabels, readCounters, sweep, writeDesk } from './sweep.mjs';
import { claim, firstJob, mayContinue, next, nextAcross, releaseAll } from './tick.mjs';
import { report } from './reviewed.mjs';
import { likelyWork, sync, toolsStale } from './preflight.mjs';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3_600_000).toISOString();
const L = (...names) => names.map((name) => ({ name }));
const issue = (number, labels = ['couchy-ux/approved'], extra = {}) =>
  ({ number, title: `Issue ${number}`, state: 'open', labels: L(...labels), created_at: ago(100), ...extra });
const pull = (number, labels, extra = {}) => ({
  number, title: `PR ${number}`, labels: L(...labels), draft: false, body: '', head: { sha: `sha${number}` },
  user: { login: 'owner' }, created_at: ago(1), ...extra,
});

/** An in-memory GitHub: issues and pulls by number, with the calls the tools make. */
function fake({ issues = [], pulls = [], subIssues = {}, reviews = {}, checks = {}, events = {}, comments = {}, blockers = {}, pushed = {}, required = [], statuses = {}, repo = 'getcouchy/couchy', onAdd } = {}) {
  const log = [];
  const find = (n) => [...issues, ...pulls].find((i) => i.number === n);
  const has = (i, names) => names.every((n) => i.labels.some((l) => l.name === n));
  return {
    log,
    repo,
    requiredChecks: async () => required,
    statuses: async (sha) => statuses[sha] ?? [],
    setStatus: async (sha, st) => { log.push(`status ${sha} ${st.state}`); (statuses[sha] ??= []).unshift(st); },
    openIssues: async (labels = []) => issues.filter((i) => i.state === 'open' && has(i, labels)),
    subIssues: async (n) => subIssues[n] ?? [],
    openPulls: async () => pulls,
    issue: async (n) => structuredClone(find(n)),
    addLabel: async (n, name) => {
      log.push(`add ${n} ${name}`);
      const i = find(n);
      if (!has(i, [name])) i.labels.push({ name });
      onAdd?.(i);
    },
    removeLabel: async (n, name) => {
      log.push(`remove ${n} ${name}`);
      const i = find(n);
      i.labels = i.labels.filter((l) => l.name !== name);
    },
    comments: async (n) => comments[n] ?? [],
    comment: async (n, body) => { log.push(`comment ${n}`); (comments[n] ??= []).push({ id: Math.random(), body, created_at: ago(0), updated_at: ago(0) }); },
    editComment: async (id) => { log.push(`edit comment ${id}`); },
    events: async (n) => events[n] ?? [],
    reviews: async (n) => reviews[n] ?? [],
    checks: async (sha) => checks[sha] ?? [],
    commit: async (sha) => ({ commit: { committer: { date: pushed[sha] ?? ago(1) } } }),
    blockers: async (i) => blockers[i.number] ?? [],
    createIssue: async (title, body, labels) => { log.push(`create ${title}`); const i = issue(999, labels, { title, body }); issues.push(i); return i; },
    editIssue: async (n, patch) => { log.push(`edit ${n}`); Object.assign(find(n), patch); },
  };
}
const LIMITS = { claim: 90, ready: 4, review: 4, fix: 2, hold: 24, heartbeat: 8 };

test('closing keywords', () => {
  assert.deepEqual(closingIssues('Closes #12.\n\nAlso fixes #3, #4 and resolves: #5. See #99.'), [12, 3, 4, 5]);
  assert.deepEqual(closingIssues('Discloses #7'), []);
  assert.deepEqual(closingIssues(null), []);
});

test('blockers are read from the issue body', () => {
  const refs = (body) => bodyBlockers(body).map((b) => `${b.repo ?? ''}#${b.number}`);
  assert.deepEqual(refs('Part of #639.\nBlocked by: #640, #641\nBlocks: the Promote to prod sub-issue'), ['#640', '#641']);
  assert.deepEqual(refs('Part of #901 (step 3 of 7). Blocked by #902. Blocks #906.'), ['#902']);
  assert.deepEqual(refs('Blocked by #902 and #904, blocks #906'), ['#902', '#904']);
  assert.deepEqual(refs('Blocked by getcouchy/couchy-agent#5, #966 (connections) and #883.'), ['getcouchy/couchy-agent#5', '#966', '#883']);
  assert.deepEqual(refs('Blocked by: none. The slices are independent. See #12.'), []);
  assert.deepEqual(refs('Blocked by nothing beyond the shell. It follows #1054.'), []);
  assert.deepEqual(refs(null), []);
});

test('a blocker counts while it is open or unreadable', async () => {
  const state = { '/repos/o/r/issues/1': 'closed', '/repos/o/r/issues/2': 'open' };
  const calls = [];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path.endsWith('/dependencies/blocked_by')) return { ok: true, status: 200, json: async () => [{ number: 9, state: 'open' }] };
    if (!state[path]) return { ok: false, status: 404, text: async () => 'Not Found' };
    return { ok: true, status: 200, json: async () => ({ state: state[path] }) };
  };
  const gh = client({ token: 't', repo: 'o/r', fetchImpl });
  const issue = { number: 5, body: 'Blocked by #1, #2 and o/other#3.' };
  assert.deepEqual(await gh.blockers(issue), ['#2', "o/other#3 (can't read it)", '#9']);
  await gh.blockers(issue);
  assert.equal(calls.filter((p) => p === '/repos/o/r/issues/2').length, 1, 'states are fetched once per run');
});

test('two providers on one issue: the alphabetically first keeps it', () => {
  assert.equal(claimWinner(issue(1, ['swarm/agent/grok', 'swarm/agent/codex'])), 'codex');
  assert.equal(claimWinner(issue(1)), null);
});

test('what makes an issue unclaimable', () => {
  const ctx = { can: new Set(['ios-sim']), linked: linkedPulls([pull(50, [], { body: 'Closes #6' })]) };
  assert.equal(whyNotClaimable(issue(1), ctx), null);
  assert.equal(whyNotClaimable(issue(1, ['couchy-ux/approved', 'swarm/needs/ios-sim']), ctx), null);
  assert.match(whyNotClaimable(issue(2, ['couchy-ux/needs-review']), ctx), /not couchy-ux\/approved/);
  assert.match(whyNotClaimable(issue(3, ['couchy-ux/approved', 'swarm/agent/grok']), ctx), /held by grok/);
  assert.match(whyNotClaimable(issue(4, ['couchy-ux/approved', 'swarm/needs/design']), ctx), /needs design/);
  assert.equal(whyNotClaimable(issue(5, ['couchy-ux/approved', 'area/app']), ctx), null, 'an area label does not queue the work');
  assert.match(whyNotClaimable(issue(6), ctx), /PR #50/);
  assert.match(whyNotClaimable(issue(7, ['couchy-ux/approved', 'kind/epic']), ctx), /epic/);
  assert.match(whyNotClaimable(issue(8, ['couchy-ux/approved', 'swarm/needs-human']), ctx), /needs-human/);
});

test('a review counts when an agent marked it or another account wrote it, never a bot', () => {
  const pr = pull(9, ['swarm/pr']);
  const r = (body, login = 'owner', type = 'User') => ({ body, state: 'COMMENTED', user: { login, type }, submitted_at: ago(1) });
  assert.equal(independentReviews(pr, [r('Looks fine <!-- agent: codex -->')]).length, 1, 'an agent with the author\'s name: a fresh session');
  assert.equal(independentReviews(pr, [r('replying in a thread')]).length, 0, 'unmarked, same account');
  assert.equal(independentReviews(pr, [r('nit', 'cubic-dev-ai[bot]', 'Bot')]).length, 0, 'a bot');
  assert.equal(independentReviews(pr, [r('Checked. <!-- agent: grok -->')]).length, 1, 'another agent');
  assert.equal(independentReviews(pr, [r('ok', 'someone-else')]).length, 1, 'a person');
  const byBot = pull(10, ['swarm/pr'], { user: { login: 'couchy-codex[bot]', type: 'Bot' } });
  assert.equal(independentReviews(byBot, [r('Checked.', 'couchy-grok[bot]', 'Bot')]).length, 1, 'another agent\'s bot');
  assert.equal(independentReviews(byBot, [r('replying', 'couchy-codex[bot]', 'Bot')]).length, 0, 'the author\'s bot, unmarked');
  assert.equal(independentReviews(byBot, [r('Fresh look <!-- agent: codex -->', 'couchy-codex[bot]', 'Bot')]).length, 1, 'the author\'s bot, marked');
  assert.equal(independentReviews(byBot, [r('nit', 'cubic-dev-ai[bot]', 'Bot')]).length, 0, 'a review bot');
});

test('a bot login names its agent', () => {
  assert.equal(agentFromLogin('couchy-claude-2[bot]'), 'claude-2');
  assert.equal(agentFromLogin('couchy-claude-2'), null);
  assert.equal(agentFromLogin('cubic-dev-ai[bot]'), null);
});

test('changes requested stop counting once the author pushes', () => {
  const pr = pull(9, ['swarm/pr']);
  const reviews = [{ body: '<!-- agent: grok -->', state: 'CHANGES_REQUESTED', user: { login: 'owner', type: 'User' }, submitted_at: ago(3) }];
  assert.deepEqual(fixReasons(pr, { reviews, pushedAt: ago(5) }), ['changes requested']);
  assert.deepEqual(fixReasons(pr, { reviews, pushedAt: ago(1) }), []);
  assert.deepEqual(
    fixReasons(pull(9, ['swarm/pr', 'conflicts-with-main']), { checks: [{ name: 'check', conclusion: 'failure' }, { name: 'lint', conclusion: 'success' }] }),
    ['conflicts with main', 'failed checks: check'],
  );
});

test('claim: taken, won, and lost to a simultaneous claim', async () => {
  let gh = fake({ issues: [issue(1, ['couchy-ux/approved', 'swarm/agent/codex'])] });
  assert.equal(await claim(gh, 1, 'grok'), false);
  assert.deepEqual(gh.log, [], 'a held issue is not touched');

  gh = fake({ issues: [issue(1)] });
  assert.equal(await claim(gh, 1, 'grok'), true);

  // Codex labels it between Grok's look and Grok's label.
  gh = fake({ issues: [issue(1)], onAdd: (i) => i.labels.some((l) => l.name === 'swarm/agent/codex') || i.labels.push({ name: 'swarm/agent/codex' }) });
  assert.equal(await claim(gh, 1, 'grok'), false);
  assert.deepEqual(gh.log, ['add 1 swarm/agent/grok', 'remove 1 swarm/agent/grok']);
  gh = fake({ issues: [issue(1)], onAdd: (i) => i.labels.some((l) => l.name === 'swarm/agent/grok') || i.labels.push({ name: 'swarm/agent/grok' }) });
  assert.equal(await claim(gh, 1, 'codex'), true, 'the winner of the same race keeps its label');
});

test('next: a label is a lock on work in progress, and any agent carries the swarm\'s work on', async () => {
  const a = pull(20, ['swarm/pr'], { body: 'Closes #1' });
  const b = pull(21, ['swarm/pr'], { body: 'Closes #2' });
  const issues = () => [issue(1), issue(2), issue(3), issue(4)];
  const failing = { sha20: [{ name: 'check', conclusion: 'failure' }] };
  const rev = (v, h = 0) => [{ body: `<!-- agent: grok${v ? ` verdict: ${v}` : ''} -->`, state: 'COMMENTED', user: { login: 'owner', type: 'User' }, submitted_at: ago(h) }];

  // A red PR nobody is on is anyone's to fix, and the fixer locks it.
  let gh = fake({ issues: issues(), pulls: structuredClone([a, b]), checks: failing });
  let job = await next(gh, { me: 'grok' });
  assert.deepEqual([job.job, job.pull, job.lock, job.claimed], ['fix', 20, 20, true]);
  assert.deepEqual(gh.log, ['add 20 swarm/agent/grok']);
  // While grok is on it, codex leaves it alone, reviews included, and takes the next thing.
  job = await next(gh, { me: 'codex' });
  assert.deepEqual([job.job, job.pull], ['review', 21]);
  // Grok's tick died: its next tick picks the same PR back up.
  job = await next(gh, { me: 'grok' });
  assert.deepEqual([job.job, job.pull], ['fix', 20]);

  // A changes verdict is work for whoever ticks; once pushed, it is a review again.
  job = await next(fake({ issues: issues(), pulls: [a], reviews: { 20: rev('changes', 0.5) } }), { me: 'claude-2' });
  assert.deepEqual([job.job, job.reasons], ['fix', ['changes requested']]);
  job = await next(fake({ issues: issues(), pulls: [a], reviews: { 20: rev('changes', 3) } }), { me: 'claude-2' });
  assert.deepEqual([job.job, job.pull], ['review', 20], 'pushed since the changes verdict');
  // Never the PR this session pushed to.
  job = await next(fake({ issues: [], pulls: [a] }), { me: 'codex', wrote: new Set([20]) });
  assert.equal(job.job, 'none');

  // A review that says ok: turn on auto-merge, unless it is on, held, or red.
  const ok = { 20: rev(null), 21: rev('ok') };
  job = await next(fake({ issues: [], pulls: [a, b], reviews: ok }), { me: 'codex' });
  assert.deepEqual([job.job, job.pull], ['merge', 21]);
  for (const label of ['swarm/needs-human', 'swarm/hold']) {
    job = await next(fake({ issues: [], pulls: [a, pull(21, ['swarm/pr', label], { body: 'Closes #2' })], reviews: ok }), { me: 'codex' });
    assert.equal(job.job, 'none', `${label} holds the merge`);
  }
  // A failed check is work, not a merge.
  job = await next(fake({ issues: [], pulls: [b], reviews: ok, checks: { sha21: [{ name: 'check', conclusion: 'failure' }] } }), { me: 'codex', doClaim: false });
  assert.deepEqual([job.job, job.claimed], ['fix', undefined]);

  const merging = { ...b, auto_merge: { merge_method: 'squash' } };
  // Auto-merge already on, and then something holds the PR: take it off.
  for (const [label, why] of [['swarm/needs-human', /needs-human/], ['swarm/hold', /swarm\/hold/]]) {
    job = await next(fake({ issues: [], pulls: [a, { ...merging, labels: [...merging.labels, { name: label }] }], reviews: ok }), { me: 'codex' });
    assert.deepEqual([job.job, job.pull], ['hold', 21]);
    assert.match(job.why, why);
  }

  // A draft nobody is on is carried on before a new issue is started, whoever opened it.
  const draft = pull(22, ['swarm/pr'], { body: 'Part of #3', draft: true, head: { sha: 'sha22', ref: 'codex/3-part-1' } });
  gh = fake({ issues: issues(), pulls: [draft] });
  job = await next(gh, { me: 'grok' });
  assert.deepEqual([job.job, job.pull, job.issue, job.branch, job.resumed], ['implement', 22, 3, 'codex/3-part-1', true]);
  assert.deepEqual(gh.log, ['add 22 swarm/agent/grok']);
  // With grok on the draft, the next agent starts something new; #3 is in progress there, so not that.
  job = await next(gh, { me: 'codex' });
  assert.deepEqual([job.job, job.issue], ['implement', 1]);

  // New issues: the blocked one is skipped, a locked one is somebody's, --look claims nothing.
  gh = fake({ issues: [issue(1, ['couchy-ux/approved', 'swarm/agent/grok']), issue(3), issue(4)], blockers: { 3: ['#77'] } });
  job = await next(gh, { me: 'codex', doClaim: false });
  assert.deepEqual([job.job, job.issue, job.lock, job.claimed], ['implement', 4, 4, undefined]);
  assert.deepEqual(gh.log, []);
  job = await next(gh, { me: 'codex' });
  assert.deepEqual(gh.log, ['add 4 swarm/agent/codex']);
  job = await next(gh, { me: 'codex' });
  assert.deepEqual([job.issue, job.resumed], [4, true], 'my lock with no PR yet is picked back up');
  // Nothing limits how many issues one name has open PRs for.
  const many = [pull(30, ['swarm/pr'], { body: 'Closes #1' }), pull(31, ['swarm/pr'], { body: 'Closes #2' }), pull(32, ['swarm/pr'], { body: 'Closes #3' })];
  const seen = Object.fromEntries([30, 31, 32].map((n) => [n, rev(null)]));
  job = await next(fake({ issues: issues(), pulls: many, reviews: seen }), { me: 'codex' });
  assert.deepEqual([job.job, job.issue], ['implement', 4]);

  // A person's PR is nobody's job.
  job = await next(fake({ issues: [], pulls: [pull(40, [], {}), pull(41, ['swarm/pr'])] }), { me: 'codex' });
  assert.deepEqual([job.job, job.pull], ['review', 41]);
  assert.equal(isSwarmPull(pull(40, [])), false);

  // The end of a job or a tick: my lock comes off everything.
  gh = fake({ issues: [issue(1, ['couchy-ux/approved', 'swarm/agent/codex']), issue(2, ['couchy-ux/approved', 'swarm/agent/grok'])], pulls: [pull(50, ['swarm/pr', 'swarm/agent/codex'])] });
  assert.deepEqual(await releaseAll(gh, 'codex'), [1, 50]);
  assert.deepEqual(gh.log, ['remove 1 swarm/agent/codex', 'remove 50 swarm/agent/codex']);
});

test('sweep: takes off locks that outlived a tick, settles doubled ones, reports the rest', async () => {
  const labeled = (name, h) => ({ event: 'labeled', label: { name }, created_at: ago(h) });
  const gh = fake({
    issues: [
      issue(1, ['couchy-ux/approved', 'swarm/agent/grok']), // lapsed
      issue(2, ['couchy-ux/approved', 'swarm/agent/grok', 'swarm/agent/codex']), // doubled, has a PR
      issue(3, ['couchy-ux/approved', 'swarm/agent/claude']), // fresh
      issue(4), // ready too long
      issue(5), // ready, but only just
      issue(6, ['couchy-ux/approved', 'couchy-ux/needs-review', 'lifecycle/claude-squad']),
      issue(7, ['swarm/needs-human']),
      issue(90, ['swarm/desk'], { title: 'Agent desk', body: '<!-- agent-desk-state: ["ready:4"] -->' }),
    ],
    pulls: [
      pull(30, ['swarm/pr'], { body: 'Closes #2', created_at: ago(9) }), // unreviewed
      pull(31, ['swarm/pr'], { created_at: ago(9) }), // red and stale
      pull(32, ['swarm/pr'], { created_at: ago(1) }), // new
      pull(33, ['swarm/pr', 'swarm/hold'], { created_at: ago(1), auto_merge: {} }), // held, yet set to merge
      pull(34, ['swarm/pr', 'swarm/hold'], { created_at: ago(30) }), // held for too long
      pull(35, ['swarm/agent/grok'], { created_at: ago(1), draft: true }), // an old lock, and not yet marked the swarm's
      pull(36, ['swarm/pr'], { created_at: ago(9), draft: true }), // a draft nobody is on
    ],
    events: {
      1: [labeled('swarm/agent/grok', 8)], 2: [labeled('swarm/agent/grok', 0.5), labeled('swarm/agent/codex', 0.5)], 3: [labeled('swarm/agent/claude', 1)],
      35: [labeled('swarm/agent/grok', 3)], 4: [labeled('couchy-ux/approved', 5)],
      5: [labeled('couchy-ux/approved', 1)], 6: [labeled('couchy-ux/approved', 1)],
      33: [labeled('swarm/hold', 1)], 34: [labeled('swarm/hold', 30)],
    },
    checks: { sha31: [{ name: 'check', conclusion: 'failure', completed_at: ago(3) }] },
    pushed: { sha31: ago(4), sha36: ago(8) },
    comments: { 90: [
      { id: 1, body: '<!-- agent-heartbeat: grok/1 -->', updated_at: ago(20) },
      { id: 2, body: '<!-- agent-heartbeat: codex/1 -->', updated_at: ago(1) },
    ] },
  });
  const result = await sweep(gh, { now: NOW, limits: LIMITS });
  // #35 is marked the swarm's before its lock comes off; lapsed locks go without a comment.
  assert.deepEqual(gh.log, ['add 35 swarm/pr', 'remove 1 swarm/agent/grok', 'remove 35 swarm/agent/grok', 'remove 2 swarm/agent/grok']);
  assert.equal(result.fixed.length, 3);
  assert.deepEqual((await gh.issue(35)).labels.map((l) => l.name), ['swarm/pr']);
  // #1 was only just released, so it is not yet "waiting".
  assert.deepEqual(result.overdue.map((o) => o.key).sort(), ['draft:36', 'fix:31', 'held:33', 'hold:34', 'human:7', 'quiet:grok/1', 'ready:4', 'review:30', 'review:34', 'stages:6']);

  await writeDesk(gh, { ...result, now: NOW });
  const posted = gh.log.slice(4);
  assert.deepEqual(posted, ['edit 90', 'comment 90']);
  const desk = await gh.issue(90);
  assert.match(desk.body, /### Needs you\n\n- #7 Issue 7/);
  assert.match(desk.body, /agent-desk-state: \["draft:36","fix:31","held:33","hold:34","human:7","quiet:grok\/1","ready:4","review:30","review:34","stages:6"\]/);

  const by = (rows) => Object.fromEntries(rows.map((r) => [r.number, r]));
  assert.equal(by(result.pulls)[36].state, 'draft');
  assert.equal(by(result.pulls)[33].state, 'hold');
  assert.equal(by(result.pulls)[31].state, 'needs_work');
  assert.equal(by(result.pulls)[30].state, 'needs_review');
  assert.equal(by(result.pulls)[30].agent, '');
  assert.deepEqual(by(result.issues)[3], { number: 3, state: 'locked', agent: 'claude' });
  assert.equal(by(result.issues)[4].state, 'claimable');
  assert.deepEqual(result.locks.map((l) => `${l.type}:${l.number}:${l.agent}`).sort(), ['issue:2:codex', 'issue:3:claude']);
  assert.deepEqual(result.heartbeats.map((h) => h.agent).sort(), ['codex/1', 'grok/1']);
  assert.deepEqual(result.fixedCounts, { lock_lapsed: 2, lock_doubled: 1 });
  assert.deepEqual(result.labelled.needsHuman, [{ number: 7, type: 'issue', agent: '' }]);
  assert.deepEqual(result.labelled.hold.map((h) => h.number).sort(), [33, 34]);
  const fix = result.overdue.find((o) => o.key === 'fix:31');
  assert.deepEqual([fix.kind, fix.number, fix.since], ['fix', 31, ago(3)]);
  const quiet = result.overdue.find((o) => o.key === 'quiet:grok/1');
  assert.deepEqual([quiet.number, quiet.agent], [null, 'grok/1']);
});

test('counters: a newly labelled item adds one; the first run only records', () => {
  const now = { needsHuman: [{ number: 7, type: 'issue', agent: 'claude' }], hold: [{ number: 34, agent: '' }] };
  const first = countLabelled(readCounters('no marker here'), now);
  assert.deepEqual(first, { needsHuman: {}, hold: {}, labelled: { needsHuman: [7], hold: [34] } });
  const second = countLabelled(readCounters(deskBody([], NOW, first)), {
    needsHuman: [...now.needsHuman, { number: 9, type: 'pull', agent: 'codex' }], hold: [],
  });
  assert.deepEqual(second.needsHuman, { 'pull|codex': 1 });
  assert.deepEqual(second.labelled, { needsHuman: [7, 9], hold: [] });
  // #34 comes back on hold: counted again.
  const third = countLabelled(readCounters(deskBody([], NOW, second)), { needsHuman: now.needsHuman, hold: now.hold });
  assert.deepEqual(third.hold, { '': 1 });
  assert.equal(readCounters('<!-- swarm-counters: {oops -->').fresh, true);
});

test('desk: comments can be turned off; the body still carries state and counters', async () => {
  const gh = fake({ issues: [issue(90, ['swarm/desk'], { body: '' })] });
  const overdue = [{ section: 'Needs you', key: 'human:7', line: '#7 x' }];
  const counters = await writeDesk(gh, { desk: await gh.issue(90), overdue, fixed: ['f'], labelled: { needsHuman: [], hold: [] }, now: NOW, comments: false });
  assert.deepEqual(gh.log, ['edit 90']);
  assert.match((await gh.issue(90)).body, /agent-desk-state: \["human:7"\] -->\n<!-- swarm-counters: /);
  assert.deepEqual(counters.labelled, { needsHuman: [], hold: [] });
});

test('desk: created on the first run with a counters marker', async () => {
  const gh = fake();
  await writeDesk(gh, { desk: null, overdue: [], fixed: [], labelled: { needsHuman: [], hold: [] }, now: NOW });
  assert.match((await gh.issue(999)).body, /swarm-counters: /);
});

test('pullState: first match wins', () => {
  const ctx = { reviews: [], checks: [], pushedAt: ago(1), gated: false };
  assert.equal(pullState(pull(1, ['swarm/pr', 'swarm/hold'], { draft: true }), ctx), 'draft');
  assert.equal(pullState(pull(1, ['swarm/pr', 'swarm/hold', 'swarm/needs-human']), ctx), 'needs_human');
  assert.equal(pullState(pull(1, ['swarm/pr', 'swarm/hold']), ctx), 'hold');
  assert.equal(pullState(pull(1, ['swarm/pr', 'conflicts-with-main']), ctx), 'needs_work');
  assert.equal(agentOf(pull(1, ['swarm/pr'], { user: { login: 'couchy-codex[bot]' } })), 'codex');
  assert.equal(agentOf(pull(1, ['swarm/pr'])), '');
});

test('desk: nothing new means no comment; an empty desk says so', async () => {
  const overdue = [{ section: 'Needs you', key: 'human:7', line: '#7 x' }];
  const gh = fake({ issues: [issue(90, ['swarm/desk'], { body: deskBody(overdue, NOW) })] });
  await writeDesk(gh, { desk: await gh.issue(90), overdue, fixed: [], now: NOW });
  assert.deepEqual(gh.log, ['edit 90']);
  assert.match(deskBody([], NOW), /Nothing is overdue\./);
  const fresh = fake();
  await writeDesk(fresh, { desk: null, overdue, fixed: [], now: NOW });
  assert.deepEqual(fresh.log, ['create Agent desk', 'comment 999']);
});

test('a tick goes on to the next job until its time is spent', async () => {
  const at = (min) => ({ startedAt: new Date(NOW - min * 60_000).toISOString(), now: NOW });
  assert.deepEqual(mayContinue(at(5)), { ok: true, left: 40 });
  assert.equal(mayContinue({ ...at(18.5), ceiling: 30 }).left, 11);
  assert.equal(mayContinue(at(50)).left, 0);
  assert.equal(mayContinue(at(19.9)).ok, true);
  assert.match(mayContinue(at(25)).why, /25 minutes/);
  assert.equal(mayContinue({ ...at(5), minutes: 4 }).ok, false);
  assert.match(mayContinue({ startedAt: undefined }).why, /no start time/);

  // A PR this session wrote is not offered back to it for review.
  const mine = pull(20, ['swarm/pr'], { body: 'Closes #1' });
  const theirs = pull(21, ['swarm/pr'], { body: 'Closes #2' });
  const issues = [issue(1, ['couchy-ux/approved', 'swarm/agent/codex']), issue(2, ['couchy-ux/approved', 'swarm/agent/grok'])];
  let job = await next(fake({ issues, pulls: [mine, theirs] }), { me: 'codex' });
  assert.deepEqual([job.job, job.pull], ['review', 20]);
  job = await next(fake({ issues, pulls: [mine, theirs] }), { me: 'codex', wrote: new Set([20]) });
  assert.deepEqual([job.job, job.pull], ['review', 21]);
});

const verdict = (v, h = 0) => ({ body: `<!-- agent: codex verdict: ${v} -->`, state: 'COMMENTED', user: { login: 'owner', type: 'User' }, submitted_at: ago(h) });

test('reviewed status: the verdict and the hold labels, posted once', async () => {
  const pr = pull(40, ['swarm/pr']);
  const state = (p, reviews) => reviewedStatus(p, reviews).state;
  assert.equal(state(pr, []), 'pending');
  assert.equal(state(pr, [verdict('changes')]), 'failure');
  assert.equal(state(pr, [verdict('changes', 2), verdict('ok')]), 'success');
  assert.equal(state(pull(40, ['swarm/pr', 'swarm/needs-human']), [verdict('ok')]), 'pending');
  assert.equal(state(pull(40, ['swarm/pr', 'swarm/hold']), [verdict('ok')]), 'pending');
  assert.equal(state(pull(40, []), []), 'success', "a person's PR is not gated");

  const gh = fake({ pulls: [pr], reviews: { 40: [verdict('ok')] } });
  assert.match(await report(gh, pr), /#40: success/);
  assert.match(await report(gh, pr), /unchanged/);
  assert.deepEqual(gh.log, ['status sha40 success']);
});

test('swarm/review-only: agents review a person\'s PR and the gate holds it, but nobody fixes, continues or merges it', async () => {
  const pr = pull(80, ['swarm/review-only']);
  assert.equal(isReviewOnly(pr), true);
  assert.equal(isSwarmPull(pr), false, 'not the swarm\'s');
  assert.equal(isSwarmPull(pull(80, ['swarm/review-only', 'swarm/pr'])), false, 'review-only wins over swarm/pr');
  assert.equal(isReviewOnly(pull(80, ['swarm/review-only', 'swarm/hands-off'])), false, 'hands-off wins over review-only');

  // The gate applies.
  const state = (p, reviews) => reviewedStatus(p, reviews).state;
  assert.equal(state(pr, []), 'pending');
  assert.equal(state(pr, [verdict('changes')]), 'failure');
  assert.equal(state(pr, [verdict('ok')]), 'success');
  assert.equal(state(pull(80, ['swarm/review-only', 'swarm/hold']), [verdict('ok')]), 'pending');

  // It is reviewed, and the job says to leave merging to its author.
  let job = await next(fake({ pulls: [pr] }), { me: 'codex' });
  assert.deepEqual([job.job, job.pull, job.reviewOnly], ['review', 80, true]);
  // Never a fix, even when red or asked for changes.
  const red = { checks: { sha80: [{ name: 'check', conclusion: 'failure' }] } };
  job = await next(fake({ pulls: [pull(80, ['swarm/review-only', 'conflicts-with-main'])], ...red }), { me: 'codex' });
  assert.equal(job.job, 'review');
  job = await next(fake({ pulls: [pr], reviews: { 80: [verdict('changes', 2)] }, pushed: { sha80: ago(3) } }), { me: 'codex' });
  assert.equal(job.job, 'none', 'its author fixes it');
  // Never set to merge or unset, gated or not.
  for (const required of [[], ['reviewed']]) {
    job = await next(fake({ pulls: [pr], reviews: { 80: [verdict('ok')] }, required }), { me: 'codex' });
    assert.equal(job.job, 'none');
    job = await next(fake({ pulls: [{ ...pr, auto_merge: {}, labels: L('swarm/review-only', 'swarm/hold') }], reviews: { 80: [verdict('ok')] }, required }), { me: 'codex' });
    assert.equal(job.job, 'none', 'auto-merge its author set stays as it is');
  }
  // A draft is not carried on.
  job = await next(fake({ pulls: [{ ...pr, draft: true }] }), { me: 'codex', doClaim: false });
  assert.equal(job.job, 'none');
});

test('reviewed status: with REVIEWED_CREATOR, another account\'s status does not count', async () => {
  const pr = pull(41, ['swarm/pr']);
  const reviews = [verdict('ok')];
  const actions = { ...reviewedStatus(pr, reviews), context: 'reviewed', creator: { login: 'github-actions[bot]' } };
  const gh = fake({ pulls: [pr], reviews: { 41: reviews }, statuses: { sha41: [actions] } });
  assert.match(await report(gh, pr, { creator: '' }), /unchanged/);
  assert.match(await report(gh, pr, { creator: 'getcouchy-swarm[bot]' }), /#41: success \(Reviewed ok\)$/);
  assert.deepEqual(gh.log, ['status sha41 success']);
});

test('with reviewed required, auto-merge goes on when the PR opens and stays on', async () => {
  const mine = pull(41, ['swarm/pr'], { body: 'Closes #1' });
  const issues = [issue(1, ['couchy-ux/approved', 'swarm/agent/codex'])];
  let job = await next(fake({ issues, pulls: [mine], required: ['check', 'reviewed'] }), { me: 'codex', wrote: new Set([41]) });
  assert.deepEqual([job.job, job.pull], ['merge', 41], 'even the PR this session just wrote');
  job = await next(fake({ issues, pulls: [mine] }), { me: 'codex', wrote: new Set([41]) });
  assert.equal(job.job, 'none', 'without the gate it waits for a verdict');
  const held = { ...mine, auto_merge: {}, labels: [...mine.labels, { name: 'swarm/needs-human' }] };
  job = await next(fake({ issues, pulls: [held], required: ['reviewed'], reviews: { 41: [verdict('ok')] } }), { me: 'codex' });
  assert.equal(job.job, 'none', 'the check holds it; auto-merge stays on');
  job = await next(fake({ issues, pulls: [{ ...mine, draft: true }], required: ['reviewed'] }), { me: 'codex', doClaim: false });
  assert.deepEqual([job.job, job.pull, job.resumed], ['implement', 41, true], 'a draft is not set to merge; it is work to carry on');
});

test('a tick covers both repositories and takes the job that comes first', async () => {
  const app = () => fake({ issues: [issue(3)] });
  const agent = (extra = {}) => fake({ repo: 'getcouchy/couchy-agent', issues: [issue(12)], ...extra });
  // A review in the second repository comes before a new issue in the first.
  let b = agent({ pulls: [pull(13, ['swarm/pr'])] });
  let job = await nextAcross([app(), b], { me: 'codex' });
  assert.deepEqual([job.repo, job.job, job.pull], ['getcouchy/couchy-agent', 'review', 13]);
  // A PR this session wrote there is not its own to review; the first repository's issue is next.
  const a = app();
  job = await nextAcross([a, b], { me: 'codex', wrote: new Map([['getcouchy/couchy-agent', new Set([13])]]) });
  assert.deepEqual([job.repo, job.job, job.issue, job.claimed], ['getcouchy/couchy', 'implement', 3, true]);
  assert.deepEqual(a.log, ['add 3 swarm/agent/codex']);
  // Nothing in the first: the second repository's queue, claimed there.
  b = agent();
  job = await nextAcross([fake(), b], { me: 'codex' });
  assert.deepEqual([job.repo, job.issue], ['getcouchy/couchy-agent', 12]);
  assert.deepEqual(b.log, ['add 12 swarm/agent/codex']);
  // A repository the token can't read is named, not fatal.
  const closed = { repo: 'getcouchy/secret', openPulls: async () => { throw Object.assign(new Error('nope'), { status: 404 }); } };
  job = await nextAcross([fake(), closed], { me: 'codex' });
  assert.equal(job.job, 'none');
  assert.match(job.why, /getcouchy\/secret: can't read it/);
});

test('preflight: a clean main fast-forwards; anything else is left and explained', () => {
  const repo = ({ branch = 'main', status = '', behind = 0, ahead = 0, ff = true }) => {
    const calls = [];
    let head = 'aaa';
    const git = (...a) => {
      calls.push(a.join(' '));
      if (a[0] === 'rev-parse' && a[1] === '--abbrev-ref') return branch;
      if (a[0] === 'status') return status.trim(); // as the real wrapper does, losing the first line's leading space
      if (a[0] === 'rev-list') return String(a[2].startsWith('HEAD..') ? behind : ahead);
      if (a[0] === 'rev-parse') return head;
      if (a[0] === 'merge') { if (!ff) throw new Error('not ff'); head = 'bbb'; }
      return '';
    };
    return { git, calls };
  };
  let r = repo({ behind: 3 });
  assert.deepEqual(sync(r.git), { state: 'updated', branch: 'main', from: 'aaa', to: 'bbb' });
  assert.ok(r.calls.includes('merge --ff-only origin/main'));
  assert.equal(sync(repo({}).git).state, 'current');

  for (const opts of [{ branch: 'codex/issue-12', behind: 3 }, { status: ' M api/x.go\n?? notes.txt', behind: 3 }]) {
    r = repo(opts);
    const left = sync(r.git);
    assert.equal(left.state, 'left');
    assert.ok(!r.calls.some((c) => c.startsWith('merge')), 'never pulls over work in progress');
  }
  assert.deepEqual(sync(repo({ status: ' M api/x.go\n?? notes.txt' }).git).dirty, ['api/x.go', 'notes.txt']);
  assert.match(sync(repo({ behind: 1, ff: false }).git).why, /git refused/);

  const left = { branch: 'codex/issue-12', dirty: ['api/x.go'] };
  assert.equal(likelyWork(left, { me: 'codex', pulls: [pull(50, ['swarm/pr'], { head: { ref: 'codex/issue-12' } })] }).pull, 50);
  const held = [issue(12, ['couchy-ux/approved', 'swarm/agent/codex']), issue(13, ['couchy-ux/approved', 'swarm/agent/grok'])];
  assert.deepEqual(likelyWork(left, { me: 'codex', issues: held }).issues, [12]);
  assert.match(likelyWork(left, { me: 'codex' }).advice, /Do not discard/);
});

test('preflight: a main ahead of origin is left alone, diverged or not', () => {
  const git = (ahead, behind) => (...a) => {
    if (a[0] === 'rev-parse' && a[1] === '--abbrev-ref') return 'main';
    if (a[0] === 'rev-list') return String(a[2].startsWith('HEAD..') ? behind : ahead);
    if (a[0] === 'merge') throw new Error('not ff');
    return '';
  };
  const ahead = sync(git(2, 0));
  assert.deepEqual([ahead.state, ahead.ahead], ['left', 2]);
  assert.match(ahead.why, /2 commits that origin\/main lacks/);
  assert.match(sync(git(1, 4)).why, /can't fast-forward/);
});

test('preflight: a detached checkout of origin/main is a place to tick from', () => {
  const repo = ({ ahead = 0, behind = 0, status = '' }) => {
    const calls = [];
    const git = (...a) => {
      calls.push(a.join(' '));
      if (a[0] === 'rev-parse' && a[1] === '--abbrev-ref') return 'HEAD';
      if (a[0] === 'status') return status;
      if (a[0] === 'rev-list') return String(a[2].startsWith('HEAD..') ? behind : ahead);
      return 'abc';
    };
    return { git, calls };
  };
  assert.equal(sync(repo({}).git).state, 'current');
  const behind = repo({ behind: 2 });
  assert.equal(sync(behind.git).state, 'updated');
  assert.ok(behind.calls.includes('checkout --quiet --detach origin/main'));
  assert.equal(sync(repo({ ahead: 1 }).git).state, 'left');
  assert.equal(sync(repo({ status: 'M  api/x.go' }).git).state, 'left');
  // Untracked files are not asked about, so a lock file can't hold a tick up.
  assert.ok(behind.calls.includes('status --porcelain --untracked-files=no'));
});

test('a checkout that was left alone is the job: nothing is claimed or offered', async () => {
  const left = { state: 'left', branch: 'main', dirty: ['api/x.go'], behind: 2, why: 'uncommitted changes' };
  const gh = fake({ issues: [issue(3), issue(12, ['couchy-ux/approved', 'swarm/agent/codex'])], pulls: [pull(13, ['swarm/pr'])] });
  const job = await firstJob([gh], left, { me: 'codex', doClaim: true });
  assert.equal(job.job, 'checkout');
  assert.deepEqual(job.issues, [12], 'names the held issue this is probably the start of');
  assert.deepEqual(gh.log, [], 'no label added, no review offered');
  // On the branch of a PR: the swarm's is mine to carry on unless another agent is on it now; a person's never.
  const onBranch = { ...left, branch: 'grok/763' };
  for (const [labels, owner, advice] of [
    [['swarm/pr'], undefined, /no other agent is on it\. Lock it \(claim 50\), commit and push/],
    [['swarm/pr', 'swarm/agent/codex'], undefined, /no other agent is on it/],
    [['swarm/pr', 'swarm/agent/grok'], 'grok', /swarm\/agent\/grok is working on now\. Leave it exactly as it is/],
    [[], null, /is a person's .*Leave it exactly/],
  ]) {
    const g = fake({ issues: [issue(3)], pulls: [pull(50, labels, { head: { ref: 'grok/763', sha: 'sha50' } })] });
    const j = await firstJob([g], onBranch, { me: 'codex', doClaim: true });
    assert.deepEqual([j.job, j.pull, j.owner], ['checkout', 50, owner]);
    assert.match(j.advice, advice);
    assert.deepEqual(g.log, []);
  }
  // A current checkout goes on to the queue as before.
  const fresh = fake({ issues: [issue(3)] });
  assert.equal((await firstJob([fresh], { state: 'current', branch: 'main' }, { me: 'codex' })).issue, 3);
  assert.deepEqual(fresh.log, ['add 3 swarm/agent/codex']);
});

test('focus: what the owner labelled goes to the front of the queue', async () => {
  const seq = issue(1412, ['swarm/focus'], { body: 'Wave 1: 1. #1300 Remove in the open 2. #1223 size rows. Deferred: #1189.' });
  const f = focus([seq]);
  assert.equal(f.of(seq), 1412);
  assert.equal(f.of(issue(5, [], { body: 'Part of #1400. Sequence: #1412 wave 2, step 18.' })), 1412);
  assert.equal(f.of(issue(5, [], { body: 'Part of #1400. See getcouchy/couchy-agent#1412 and #14120.' })), null);
  assert.equal(f.of(issue(1223, [], { body: 'No mention of the sequence.' })), 1412, 'named by the focused issue');
  // Listed issues in the order the focused issue lists them, then others in focus, then the rest.
  const mixed = [issue(7), issue(1223), issue(1250, [], { body: 'Sequence: #1412' }), issue(1300)];
  assert.deepEqual(f.order(mixed).map((i) => i.number), [1300, 1223, 1250, 7]);
  // The label on the epic and on some children: those children first, in the epic's order, then its other children.
  const kids = [issue(1223, ['swarm/focus']), issue(1300), issue(1189, ['swarm/focus']), issue(9, ['swarm/focus'])];
  const both = focus([seq, kids[0], kids[2], kids[3]]);
  assert.deepEqual(both.order([issue(7), ...kids]).map((i) => i.number), [1223, 1189, 9, 1300, 7]);

  // Sub-issues the body does not name are in focus too, after the ones it lists, in GitHub's order.
  const withSubs = focus([seq], new Map([[1412, [40, 1223, 30]]]));
  assert.equal(withSubs.of(issue(30)), 1412);
  assert.deepEqual(withSubs.order([issue(7), issue(30), issue(40), issue(1223), issue(1300)]).map((i) => i.number), [1300, 1223, 40, 30, 7]);
  const viaLink = await next(fake({ issues: [issue(3, ['couchy-ux/approved']), issue(1412, ['swarm/focus']), issue(30, ['couchy-ux/approved'])], subIssues: { 1412: [30] } }), { me: 'codex' });
  assert.deepEqual([viaLink.issue, viaLink.focus], [30, 1412]);

  const queue = () => [
    issue(3), // older, not in focus
    issue(1412, ['swarm/focus', 'kind/epic']),
    issue(1402, ['couchy-ux/approved'], { body: 'Sequence: #1412 wave 2' }),
    issue(1403, ['couchy-ux/approved'], { body: 'Sequence: #1412 wave 3' }),
  ];
  let job = await next(fake({ issues: queue() }), { me: 'codex' });
  assert.deepEqual([job.issue, job.focus], [1402, 1412]);
  // Focused work that can't be taken yet doesn't hold the rest of the queue up.
  job = await next(fake({ issues: queue(), blockers: { 1402: ['#9'], 1403: ['#9'] } }), { me: 'codex' });
  assert.deepEqual([job.issue, job.focus], [3, undefined]);
  // A review still comes before a focused issue.
  job = await next(fake({ issues: queue(), pulls: [pull(60, ['swarm/pr'])] }), { me: 'codex' });
  assert.equal(job.job, 'review');
  // Across repositories, the focused issue wins over an unfocused one in the home repository.
  const a = fake({ issues: [issue(3)] });
  const b = fake({ repo: 'getcouchy/couchy-agent', issues: [issue(12, ['couchy-ux/approved', 'swarm/focus'])] });
  job = await nextAcross([a, b], { me: 'codex' });
  assert.deepEqual([job.repo, job.issue], ['getcouchy/couchy-agent', 12]);
  assert.deepEqual(a.log, []);
});

test('labels from before the swarm/ namespace are read as today\'s and moved across', async () => {
  for (const [old, now] of [['agent/claude-2', 'swarm/agent/claude-2'], ['needs-human', 'swarm/needs-human'], ['merge/hold', 'swarm/hold'],
    ['focus', 'swarm/focus'], ['agent-desk', 'swarm/desk'], ['needs/ios-sim', 'swarm/needs/ios-sim']]) {
    assert.equal(canonical(old), now);
    assert.equal(oldName(now), old);
    assert.equal(canonical(now), now);
  }
  assert.equal(canonical('couchy-ux/approved'), 'couchy-ux/approved');
  assert.equal(oldName('area/app'), null);

  // An issue held under the old name is held: nobody else claims it, and its holder resumes it.
  const old = () => [issue(1, ['couchy-ux/approved', 'agent/' + 'grok']), issue(2, ['couchy-ux/approved', 'needs/' + 'ios-sim'])];
  assert.equal(await claim(fake({ issues: old() }), 1, 'codex'), false);
  assert.deepEqual([(await next(fake({ issues: old() }), { me: 'grok' })).issue, (await next(fake({ issues: old() }), { me: 'grok' })).resumed], [1, true]);
  assert.equal((await next(fake({ issues: old() }), { me: 'codex' })).job, 'none', 'the old needs/ label still gates');
  assert.equal(reviewedStatus(pull(9, ['swarm/pr', 'merge/' + 'hold']), []).description, 'Held: swarm/hold');

  // The sweep renames a label that only exists under its old name, and moves stragglers when both exist.
  const log = [];
  const gh = {
    labels: async () => ['agent/' + 'codex', 'needs-human', 'swarm/needs-human', 'area/app', 'swarm/focus'].map((name) => ({ name })),
    renameLabel: async (a, b) => log.push(`rename ${a} -> ${b}`),
    labelled: async (name) => (name === 'needs-human' ? [{ number: 7 }] : []),
    addLabel: async (n, name) => log.push(`add ${n} ${name}`),
    removeLabel: async (n, name) => log.push(`remove ${n} ${name}`),
  };
  const moved = await migrateLabels(gh);
  assert.deepEqual(log, ['rename agent/codex -> swarm/agent/codex', 'add 7 swarm/needs-human', 'remove 7 needs-human']);
  assert.equal(moved.length, 2);
});

test('the client looks for a swarm label under its old name too, and removes both', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${decodeURIComponent(url.replace('https://api.github.com/repos/o/r', ''))}`);
    const body = url.includes('labels=focus') ? [{ number: 2, created_at: '2026-01-01' }] : url.includes('labels=swarm') ? [{ number: 5, created_at: '2026-02-01' }] : [];
    return { ok: true, status: init.method === 'DELETE' ? 204 : 200, json: async () => body, text: async () => '' };
  };
  const gh = client({ token: 't', repo: 'o/r', fetchImpl });
  assert.deepEqual((await gh.openIssues(['swarm/focus'])).map((i) => i.number), [2, 5], 'both names, oldest first');
  await gh.removeLabel(9, 'swarm/agent/codex');
  assert.deepEqual(calls.filter((c) => c.startsWith('DELETE')), ['DELETE /issues/9/labels/swarm/agent/codex', 'DELETE /issues/9/labels/agent/codex']);
});

test('a claim under both the old name and today\'s is one holder; stale tools are detected', () => {
  const both = issue(763, ['couchy-ux/approved', 'agent/' + 'grok', 'swarm/agent/grok']);
  assert.deepEqual(providers(both), ['grok']);
  assert.equal(whyNotClaimable(both, {}), 'held by grok');

  const git = (differs) => (...a) => { if (a[0] === 'diff' && differs) throw new Error('exit 1'); return ''; };
  assert.equal(toolsStale(git(true)), true);
  assert.equal(toolsStale(git(false)), false);
});

test('a builder tick builds what is in focus and nothing else; other ticks review focus first', async () => {
  const seq = issue(1412, ['swarm/focus'], { body: 'Wave 1: #1223' });
  const issues = () => [issue(3), seq, issue(1223), issue(1224, ['couchy-ux/approved', 'swarm/agent/grok'], { body: 'Sequence: #1412' })];
  const theirs = pull(60, ['swarm/pr'], { body: 'Closes #9', created_at: ago(5) });
  const theirsFocus = pull(61, ['swarm/pr'], { body: 'Closes #1224', created_at: ago(1) });

  // A builder skips the review and the older unfocused issue, and takes the focused one.
  let gh = fake({ issues: issues(), pulls: [theirs, theirsFocus] });
  let job = await next(gh, { me: 'codex-focus-1', role: 'focus' });
  assert.deepEqual([job.job, job.issue, job.focus], ['implement', 1223, 1412]);
  assert.deepEqual(gh.log, ['add 1223 swarm/agent/codex-focus-1']);
  // With nothing in focus left to take it stops, though #3 is free.
  job = await next(fake({ issues: [issue(3), seq], pulls: [theirs] }), { me: 'codex-focus-1', role: 'focus' });
  assert.deepEqual([job.job, job.why], ['none', 'nothing in focus is claimable']);
  // A PR in focus that needs work comes first, whoever opened it; one outside focus is not a builder's.
  const mine = pull(62, ['swarm/pr'], { body: 'Closes #1223' });
  job = await next(fake({ issues: issues(), pulls: [mine], checks: { sha62: [{ name: 'check', conclusion: 'failure' }] } }), { me: 'codex-focus-1', role: 'focus' });
  assert.deepEqual([job.job, job.pull], ['fix', 62]);
  job = await next(fake({ issues: [seq], pulls: [theirs], checks: { sha60: [{ name: 'check', conclusion: 'failure' }] } }), { me: 'codex-focus-1', role: 'focus' });
  assert.equal(job.job, 'none');
  // It turns auto-merge on for a PR in focus where reviewed is required, and leaves the others.
  job = await next(fake({ issues: issues(), pulls: [theirs, mine], required: ['reviewed'] }), { me: 'codex-focus-1', role: 'focus' });
  assert.deepEqual([job.job, job.pull], ['merge', 62]);

  // An ordinary tick reviews the PR in focus before an older one that isn't.
  job = await next(fake({ issues: issues(), pulls: [theirs, theirsFocus] }), { me: 'codex' });
  assert.deepEqual([job.job, job.pull, job.focus], ['review', 61, true]);
});

test('main\'s failing simulator flows (the nightly issue) come before approved issues, for an agent with a simulator', async () => {
  const nightly = issue(1600, ['ios-sim/nightly', 'swarm/needs/ios-sim']);
  const focused = issue(1223, ['couchy-ux/approved', 'swarm/focus']);
  assert.equal(whyNotClaimable(nightly, { can: new Set(['ios-sim']) }), null, 'no UX approval needed');
  let job = await next(fake({ issues: [issue(3), focused, nightly] }), { me: 'claude-2', can: new Set(['ios-sim']) });
  assert.deepEqual([job.job, job.issue], ['implement', 1600]);
  // An agent without a simulator passes it by; a builder takes only focus.
  job = await next(fake({ issues: [issue(3), nightly] }), { me: 'grok' });
  assert.deepEqual([job.job, job.issue], ['implement', 3]);
  job = await next(fake({ issues: [focused, nightly] }), { me: 'codex-focus-1', role: 'focus', can: new Set(['ios-sim']) });
  assert.deepEqual([job.job, job.issue], ['implement', 1223]);
});

test('swarm/hands-off takes an issue or a PR out of the agents\' hands', async () => {
  const red = { sha70: [{ name: 'check', conclusion: 'failure' }] };
  const mine = pull(70, ['swarm/pr', 'swarm/hands-off'], { body: 'Closes #1' });
  // Not fixed, reviewed or set to merge, and the issue it closes is not offered as new work.
  let gh = fake({ issues: [issue(1), issue(2, ['couchy-ux/approved', 'swarm/hands-off']), issue(3)], pulls: [mine], checks: red, required: ['reviewed'] });
  const job = await next(gh, { me: 'codex' });
  assert.deepEqual([job.job, job.issue], ['implement', 3]);
  assert.equal(isSwarmPull(mine), false);
  assert.equal(reviewedStatus(mine, []).state, 'success', 'the gate does not wait for an agent on it');
  // A person's PR with no swarm label keeps its issue out of the queue too.
  gh = fake({ issues: [issue(1), issue(3)], pulls: [pull(71, [], { body: 'Closes #1' })] });
  assert.equal((await next(gh, { me: 'codex' })).issue, 3);
});

test('every label the sweep creates has a description GitHub will accept', () => {
  for (const [name, color, description] of LABELS) {
    assert.ok(description.length <= 100, `${name}: ${description.length} characters`);
    assert.match(color, /^[0-9a-f]{6}$/);
    assert.ok(name.startsWith('swarm/'));
  }
});
