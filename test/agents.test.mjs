// node --test
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  agentFromLogin, agentOf, bodyBlockers, claimWinner, closingIssues, fixReasons, independentReviews, canonical, lockLapsed, openParents, pullState, isReviewOnly, isSwarmPull, oldNames, providers, linkedPulls, reviewedStatus, requestKind, whyNotClaimable, whyNotBreakdown,
} from '../lib/rules.mjs';
import { client } from '../lib/github.mjs';
import { LABELS, countLabelled, deskBody, migrateLabels, readCounters, sweep, sweepMetrics, writeDesk } from '../sweep.mjs';
import { registry } from '../lib/metrics.mjs';
import { claim, firstJob, focusOf, mayContinue, next, nextAcross, releaseAll } from '../lib/tick.mjs';
import { run, UsageError, writeEvent } from '../lib/commands.mjs';
import { report, status } from '../reviewed.mjs';
import { likelyWork, sync, toolsStale } from '../lib/preflight.mjs';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3_600_000).toISOString();
const L = (...names) => names.map((name) => ({ name }));
// A work item, shaped as plane.mjs shapes one; in Todo unless `stage` says
// otherwise, and in focus (agents start nothing else) unless `labels` says otherwise.
const issue = (number, labels = ['couchy-ux/approved', 'swarm/focus'], extra = {}) =>
  ({ number, title: `Issue ${number}`, state: 'open', stage: 'unstarted', labels: L(...labels), created_at: ago(100), updated_at: ago(100), ...extra });
const pull = (number, labels, extra = {}) => ({
  number, title: `PR ${number}`, labels: L(...labels), draft: false, body: '', head: { sha: `sha${number}` },
  user: { login: 'owner' }, created_at: ago(1), ...extra,
});

/** An in-memory GitHub: issues and pulls by number, with the calls the tools make. */
function fake({ issues = [], pulls = [], subIssues = {}, reviews = {}, checks = {}, events = {}, comments = {}, blockers = {}, blocking = {}, qa = [], closed = [], pushed = {}, required = [], statuses = {}, repo = 'getcouchy/couchy', onAdd } = {}) {
  const log = [];
  const find = (n) => [...issues, ...closed, ...pulls].find((i) => i.number === n);
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
    blocking: async (i) => blocking[i.number] ?? [],
    inQA: async () => qa,
    labelledItems: async (name) => [...issues, ...closed].filter((i) => i.labels.some((l) => l.name === name)),
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
  assert.match(whyNotClaimable(issue(2, ['couchy-ux/needs-review'], { stage: 'backlog' }), ctx), /not ready: in backlog/);
  assert.equal(whyNotClaimable(issue(2, [], { stage: 'started' }), ctx), null, 'In Progress with nobody on it and no PR is work let go of');
  assert.match(whyNotClaimable(issue(9, ['swarm/desk'], { stage: 'backlog' }), ctx), /Agent desk/);
  assert.match(whyNotClaimable(issue(3, ['couchy-ux/approved', 'swarm/agent/grok']), ctx), /held by grok/);
  assert.match(whyNotClaimable(issue(4, ['couchy-ux/approved', 'swarm/needs/design']), ctx), /needs design/);
  assert.equal(whyNotClaimable(issue(5, ['couchy-ux/approved', 'area/app']), ctx), null, 'an area label does not queue the work');
  assert.match(whyNotClaimable(issue(6), ctx), /PR #50/);
  assert.match(whyNotClaimable(issue(7, [], { id: 'i7' }), { ...ctx, parents: openParents([issue(70, [], { parent: 'i7' })]) }), /sub-issues/);
  assert.equal(openParents([issue(70, [], { parent: 'i7', state: 'closed' })]).size, 0, 'a closed child leaves its parent to be built');
  assert.match(whyNotClaimable(issue(8, ['couchy-ux/approved', 'swarm/needs-human']), ctx), /needs-human/);
  assert.match(whyNotClaimable(issue(10, [], { stage: 'needs-human' }), ctx), /Needs Human/);
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

test('a held PR is not fix work, except for a changes verdict on one held with swarm/hold', () => {
  const checks = [{ name: 'smoke', conclusion: 'failure' }];
  const reviews = [{ body: '<!-- agent: grok verdict: changes -->', state: 'COMMENTED', user: { login: 'owner', type: 'User' }, submitted_at: ago(1) }];
  const held = (label) => pull(9, ['swarm/pr', 'conflicts-with-main', label]);
  // Waiting on a person: nothing moves until the label comes off.
  assert.deepEqual(fixReasons(held('swarm/needs-human'), { checks, reviews, pushedAt: ago(2) }), []);
  // Waiting on something else to land: a red check or a conflict is expected
  // until it does, but a reviewer's changes are about this PR's own code.
  assert.deepEqual(fixReasons(held('swarm/hold'), { checks }), []);
  assert.deepEqual(fixReasons(held('swarm/hold'), { checks, reviews, pushedAt: ago(2) }), ['changes requested']);
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
  // A held PR's red check is not a fix job. It still gets its review.
  for (const label of ['swarm/needs-human', 'swarm/hold']) {
    job = await next(fake({ issues: [], pulls: [pull(20, ['swarm/pr', label], { body: 'Closes #1' })], checks: failing }), { me: 'codex' });
    assert.deepEqual([job.job, job.pull], ['review', 20], `${label} is not offered as a fix`);
    job = await next(fake({ issues: [], pulls: [pull(20, ['swarm/pr', label], { body: 'Closes #1' })], checks: failing, reviews: { 20: rev('ok') } }), { me: 'codex' });
    assert.equal(job.job, 'none', `${label}, once reviewed, is no job at all`);
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
  assert.deepEqual(await releaseAll(gh, 'codex'), [{ number: 1, type: 'issue', title: 'Issue 1' }, { number: 50, type: 'pull', title: 'PR 50' }]);
  assert.deepEqual(gh.log, ['remove 1 swarm/agent/codex', 'remove 50 swarm/agent/codex']);
});

test('sweep: takes off locks that outlived a tick, settles doubled ones, reports the rest', async () => {
  const labeled = (name, h) => ({ event: 'labeled', label: { name }, created_at: ago(h) });
  const gh = fake({
    issues: [
      issue(1, ['couchy-ux/approved', 'swarm/agent/grok']), // lapsed
      issue(2, ['couchy-ux/approved', 'swarm/agent/grok', 'swarm/agent/codex']), // doubled, has a PR
      issue(3, ['couchy-ux/approved', 'swarm/agent/claude']), // fresh
      issue(4, undefined, { updated_at: ago(5) }), // ready too long
      issue(5, undefined, { updated_at: ago(1) }), // ready, but only just
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
      35: [labeled('swarm/agent/grok', 3)],
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
  assert.deepEqual(result.overdue.map((o) => o.key).sort(), ['draft:36', 'fix:31', 'held:33', 'hold:34', 'human:7', 'quiet:grok/1', 'ready:4', 'review:30', 'review:34']);

  await writeDesk(gh, { ...result, now: NOW });
  const posted = gh.log.slice(4);
  assert.deepEqual(posted, ['edit 90', 'comment 90']);
  const desk = await gh.issue(90);
  assert.match(desk.body, /### Needs you\n\n- #7 Issue 7/);
  assert.match(desk.body, /agent-desk-state: \["draft:36","fix:31","held:33","hold:34","human:7","quiet:grok\/1","ready:4","review:30","review:34"\]/);

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

test('sweep: only work in focus is waiting for an agent; Needs you says what each item holds up', async () => {
  const issues = [
    issue(1, ['couchy-ux/approved']), // ready for days, but outside focus
    issue(2), // ready for days, in focus
    issue(5, ['swarm/needs-human'], { body: 'Which one?' }),
    issue(6, undefined, { body: 'Blocked by #5.' }),
    issue(7, ['couchy-ux/approved'], { body: 'Blocked by #6.' }),
    issue(8, ['swarm/needs-human']),
  ];
  const { overdue } = await sweep(fake({ issues, blockers: { 6: [5], 7: [6] }, blocking: { 8: [1] } }), { now: NOW, limits: LIMITS });
  const lines = (section) => overdue.filter((o) => o.section === section).map((o) => o.line);
  assert.deepEqual(lines('Waiting for an agent').map((l) => l.split(' ')[0]), ['#2'], '#1 is ready too, but outside focus');
  assert.deepEqual(lines('Needs you'), [
    '#5 Issue 5. Holds up #6 (in focus), and 1 more further down.',
    '#8 Issue 8. Holds up #1.',
  ]);
  // swarm/blocked follows the blockers: on while one is open, off once none is or the item closes.
  const tagged = [issue(30), issue(31, ['couchy-ux/approved', 'swarm/blocked']), issue(32, ['couchy-ux/approved', 'swarm/blocked'])];
  const done = issue(33, ['area/app', 'swarm/blocked'], { state: 'closed', stage: 'completed' });
  const gh = fake({ issues: tagged, closed: [done], blockers: { 30: ['#9'], 31: ['#9'] } });
  await sweep(gh, { now: NOW, limits: LIMITS });
  assert.deepEqual(gh.log.filter((l) => l.includes('swarm/blocked')), ['add 30 swarm/blocked', 'remove 32 swarm/blocked', 'remove 33 swarm/blocked']);
  // Merged work waiting for the owner's QA is on the desk too.
  const withQA = await sweep(fake({ qa: [issue(9, ['area/app'], { stage: 'qa', state: 'closed', updated_at: ago(3) })] }), { now: NOW, limits: LIMITS });
  assert.deepEqual(withQA.overdue.filter((o) => o.section === 'Waiting for your review').map((o) => [o.line, o.since]), [['#9 Issue 9', ago(3)]]);
});

test('sweep: an agent with several heartbeat comments is listed once, by its newest', async () => {
  const comments = (...hours) => ({ 90: hours.map(([agent, h], i) => ({ id: i + 1, body: `<!-- agent-heartbeat: ${agent} -->`, updated_at: ago(h) })) });
  const desk = issue(90, ['swarm/desk']);
  const stale = await sweep(fake({ issues: [desk], comments: comments(['grok', 30], ['grok', 12], ['grok', 20]) }), { now: NOW, limits: LIMITS });
  const quiet = stale.overdue.filter((o) => o.kind === 'quiet');
  assert.deepEqual(quiet.map((o) => [o.key, o.since]), [['quiet:grok', ago(12)]]);
  assert.match(quiet[0].line, /last ticked 12 hours ago/);
  // A fresh comment beside stale ones means the agent is ticking.
  const ticking = await sweep(fake({ issues: [desk], comments: comments(['grok', 30], ['grok', 1]) }), { now: NOW, limits: LIMITS });
  assert.deepEqual(ticking.overdue.filter((o) => o.kind === 'quiet'), []);
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

test('sweep metrics: one series per item, limits in seconds', () => {
  const reg = registry();
  sweepMetrics(reg, {
    result: {
      pulls: [{ number: 30, state: 'needs_review', agent: '' }], issues: [{ number: 3, state: 'locked', agent: 'claude' }],
      locks: [{ number: 3, agent: 'claude', type: 'issue', since: ago(1) }], heartbeats: [{ agent: 'grok/1', at: ago(20) }],
      overdue: [{ kind: 'quiet', number: null, agent: 'grok/1', since: ago(20) }, { kind: 'human', number: 6, agent: '', since: null }],
      fixedCounts: { lock_lapsed: 2, lock_doubled: 1 },
    },
    counters: { needsHuman: { 'issue|claude': 3 }, hold: {} }, migrated: 0, limits: LIMITS, now: NOW, startedAt: NOW - 4000, rateLimit: 4321,
  });
  const out = reg.render();
  assert.match(out, /swarm_pulls\{number="30",state="needs_review",agent=""\} 1\n/);
  assert.match(out, /swarm_lock_age_seconds\{number="3",agent="claude",type="issue"\} 3600\n/);
  assert.match(out, /swarm_overdue_age_seconds\{number="",kind="quiet",agent="grok\/1"\} 72000\n/);
  assert.match(out, /swarm_overdue_age_seconds\{number="6",kind="human",agent=""\} 0\n/);
  assert.match(out, /swarm_limit_seconds\{limit="claim"\} 5400\n/);
  assert.match(out, /swarm_limit_seconds\{limit="heartbeat"\} 28800\n/);
  assert.match(out, /swarm_sweep_fixed\{action="label_migrated"\} 0\n/);
  assert.match(out, /swarm_needs_human_total\{type="issue",agent="claude"\} 3\n/);
  assert.match(out, /swarm_hold_total\{agent=""\} 0\n/);
  assert.match(out, /swarm_job_duration_seconds 4\n/);
  assert.match(out, /swarm_github_rate_limit_remaining 4321\n/);
});

test('sweep metrics: an agent with several heartbeat comments reports its newest', () => {
  const reg = registry();
  sweepMetrics(reg, {
    result: {
      pulls: [], issues: [], locks: [], overdue: [], fixedCounts: { lock_lapsed: 0, lock_doubled: 0 },
      heartbeats: [{ agent: 'grok', at: ago(16) }, { agent: 'grok', at: ago(8) }, { agent: 'grok', at: ago(14) }],
    },
    counters: { needsHuman: {}, hold: {} }, limits: LIMITS, now: NOW,
  });
  assert.match(reg.render(), new RegExp(`swarm_agent_last_tick_timestamp_seconds\\{agent="grok"\\} ${(NOW - 8 * 3_600_000) / 1000}\\n`));
});

test('sweep metrics: each agent seen in a run has its counters, at 0 until it is counted', () => {
  // increase() reads nothing from a series that is born at 1, so the 0 has to be there first.
  const reg = registry();
  sweepMetrics(reg, {
    result: {
      pulls: [{ number: 30, state: 'needs_review', agent: 'codex' }], issues: [], locks: [{ number: 3, agent: 'claude', type: 'issue', since: ago(1) }],
      heartbeats: [], overdue: [], fixedCounts: { lock_lapsed: 0, lock_doubled: 0 },
    },
    counters: { needsHuman: { 'issue|claude': 3 }, hold: {} }, limits: LIMITS, now: NOW,
  });
  const out = reg.render();
  assert.match(out, /swarm_needs_human_total\{type="issue",agent="claude"\} 3\n/);
  assert.match(out, /swarm_needs_human_total\{type="pull",agent="claude"\} 0\n/);
  assert.match(out, /swarm_needs_human_total\{type="pull",agent="codex"\} 0\n/);
  assert.match(out, /swarm_needs_human_total\{type="issue",agent=""\} 0\n/);
  assert.match(out, /swarm_hold_total\{agent="codex"\} 0\n/);
});

test('counters: a marker of the wrong shape is a fresh start', () => {
  const marker = (c) => `<!-- swarm-counters: ${JSON.stringify(c)} -->`;
  const ok = { needsHuman: { 'issue|claude': 3 }, hold: {}, labelled: { needsHuman: [7], hold: [] } };
  assert.equal(readCounters(marker(ok)).fresh, false);
  assert.equal(readCounters(marker({ ...ok, hold: 'ab' })).fresh, true);
  assert.equal(readCounters(marker({ ...ok, needsHuman: { 'issue|claude': '3' } })).fresh, true);
  assert.equal(readCounters(marker({ ...ok, labelled: { needsHuman: 'x', hold: [] } })).fresh, true);
});

test('desk: with comments off, the body does not promise one', () => {
  assert.match(deskBody([], NOW), /A comment is added once/);
  const quiet = deskBody([], NOW, undefined, { comments: false });
  assert.doesNotMatch(quiet, /A comment is added/);
  assert.match(quiet, /heartbeats/);
});

test('client: remembers the rate limit left', async () => {
  const gh = client({ token: 't', repo: 'a/b', fetchImpl: async () => ({ ok: true, status: 200, json: async () => [], headers: new Headers({ 'x-ratelimit-remaining': '4999' }) }) });
  assert.equal(gh.rateLimitRemaining(), null);
  await gh.labels();
  assert.equal(gh.rateLimitRemaining(), 4999);
});

test('reviewed: status returns the state it posted', async () => {
  const gh = fake({ pulls: [pull(40, ['swarm/pr'])] });
  const { line, state } = await status(gh, (await gh.openPulls())[0]);
  assert.equal(state, 'pending');
  assert.match(line, /^#40: pending/);
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
  const issues = [issue(1, ['couchy-ux/approved', 'swarm/focus', 'swarm/agent/codex'])];
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

test('focus: agents start only what is in focus, highest priority first, then what most work waits on', async () => {
  // In focus: the sprint, its children, and what those wait on, down the chain. A description naming an item is not enough.
  const seq = issue(1412, ['swarm/focus'], { body: 'Wave 1: #1300. Deferred: #1189.' });
  const open = [seq, issue(1300, []), issue(1189, []), issue(30, []), issue(31, []), issue(32, []), issue(5, [], { body: 'Sequence: #1412 wave 2.' })];
  const f = await focusOf(fake({ issues: open, subIssues: { 1412: [30] }, blockers: { 1412: ['#31'], 30: [32] } }), open);
  assert.deepEqual([1412, 30, 31, 32].map((n) => f.of(issue(n))), [1412, 1412, 1412, 1412]);
  assert.deepEqual([1300, 1189, 5].map((n) => f.of(open.find((i) => i.number === n))), [null, null, null], 'named in a description, or naming the sprint item');
  const viaLink = await next(fake({ issues: [issue(3, ['couchy-ux/approved']), issue(1412, ['swarm/focus'], { stage: 'backlog' }), issue(30, ['couchy-ux/approved'])], subIssues: { 1412: [30] } }), { me: 'codex' });
  assert.deepEqual([viaLink.issue, viaLink.focus], [30, 1412]);

  const queue = () => [
    issue(3, ['couchy-ux/approved']), // older, not in focus
    issue(1412, ['swarm/focus'], { id: 'i1412' }),
    issue(1402, ['couchy-ux/approved'], { parent: 'i1412' }),
    issue(1403, ['couchy-ux/approved'], { parent: 'i1412' }),
  ];
  const subIssues = { 1412: [1402, 1403] };
  let job = await next(fake({ issues: queue(), subIssues }), { me: 'codex' });
  assert.deepEqual([job.issue, job.focus], [1402, 1412]);
  // With nothing in focus claimable the tick starts nothing, though #3 is free.
  const gh = fake({ issues: queue(), subIssues, blockers: { 1402: ['#9'], 1403: ['#9'] } });
  job = await next(gh, { me: 'codex' });
  assert.deepEqual([job.job, job.why], ['none', 'nothing in focus is claimable']);
  assert.deepEqual(gh.log, []);
  // A review still comes before a focused issue.
  job = await next(fake({ issues: queue(), subIssues, pulls: [pull(60, ['swarm/pr'])] }), { me: 'codex' });
  assert.equal(job.job, 'review');
  // Across repositories, the focused issue wins; the home repository's unfocused one is not taken.
  const a = fake({ issues: [issue(3, ['couchy-ux/approved'])] });
  const b = fake({ repo: 'getcouchy/couchy-agent', issues: [issue(12)] });
  job = await nextAcross([a, b], { me: 'codex' });
  assert.deepEqual([job.repo, job.issue], ['getcouchy/couchy-agent', 12]);
  assert.deepEqual(a.log, []);

  // Priority first: urgent before high before none, whatever the order they come in.
  const ranked = (issues, extra = {}) => next(fake({ issues, ...extra }), { me: 'codex', doClaim: false });
  job = await ranked([issue(10, undefined, { priority: 'none' }), issue(11, undefined, { priority: 'high' }), issue(12, undefined, { priority: 'urgent' })]);
  assert.equal(job.issue, 12);
  // Between equals, the one more work waits on, down the whole chain of "Blocked by" lines.
  const chain = () => [
    issue(20, undefined, { priority: 'high' }),
    issue(21, undefined, { priority: 'high' }),
    issue(22, ['couchy-ux/approved'], { body: 'Blocked by #21.' }), // not in focus itself: still waits on #21
    issue(23, ['couchy-ux/approved'], { body: 'Blocked by COUCHYUX-9 and #22.' }),
    issue(24, undefined, { priority: 'urgent', body: 'Blocked by #20.' }), // urgent, but waits on #20: not a candidate
  ];
  job = await ranked(chain(), { blockers: { 24: ['#20'] } });
  assert.equal(job.issue, 21, '#21 holds up #22 and #23; #20 holds up only #24');
  // Plane's blocking relations count too.
  job = await ranked(chain(), { blockers: { 24: ['#20'] }, blocking: { 20: [30, 31, 32] } });
  assert.equal(job.issue, 20);
  // Equal on both: the order they came in.
  job = await ranked([issue(41), issue(40)]);
  assert.equal(job.issue, 41);

  // A draft for work outside focus is not carried on; one in focus is.
  const draft = (n) => pull(70, ['swarm/pr'], { draft: true, body: `Part of #${n}`, head: { sha: 'sha70', ref: `codex/${n}` } });
  job = await next(fake({ issues: [issue(3, ['couchy-ux/approved'])], pulls: [draft(3)] }), { me: 'codex' });
  assert.equal(job.job, 'none');
  job = await next(fake({ issues: [issue(4)], pulls: [draft(4)] }), { me: 'codex' });
  assert.deepEqual([job.job, job.pull, job.resumed], ['implement', 70, true]);
  // A non-draft PR outside focus is still reviewed and fixed, so written work lands.
  job = await next(fake({ issues: [issue(3, ['couchy-ux/approved'])], pulls: [pull(71, ['swarm/pr'], { body: 'Closes #3' })] }), { me: 'codex' });
  assert.deepEqual([job.job, job.pull], ['review', 71]);
});

test('labels from before the swarm/ namespace are read as today\'s and moved across', async () => {
  for (const [old, now] of [['agent/claude-2', 'swarm/agent/claude-2'], ['needs-human', 'swarm/needs-human'], ['merge/hold', 'swarm/hold'],
    ['focus', 'swarm/focus'], ['agent-desk', 'swarm/desk'], ['needs/ios-sim', 'swarm/needs/ios-sim']]) {
    assert.equal(canonical(old), now);
    assert.deepEqual(oldNames(now), [old]);
    assert.equal(canonical(now), now);
  }
  assert.equal(canonical('couchy-ux/approved'), 'couchy-ux/approved');
  assert.deepEqual(oldNames('area/app'), []);
  assert.deepEqual(oldNames('swarm/task-breakdown'), ['swarm/groom', 'swarm/needs-shaping'], 'a label can have had more than one');
  assert.deepEqual([requestKind(issue(1, ['swarm/' + 'needs-shaping'])), requestKind(issue(1, ['swarm/' + 'groom']))], ['task-breakdown', 'task-breakdown']);

  // An issue held under the old name is held: nobody else claims it, and its holder resumes it.
  const old = () => [issue(1, ['couchy-ux/approved', 'swarm/focus', 'agent/' + 'grok']), issue(2, ['couchy-ux/approved', 'swarm/focus', 'needs/' + 'ios-sim'])];
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
  const seq = issue(1412, ['swarm/focus'], { stage: 'backlog' });
  const issues = () => [issue(3, ['couchy-ux/approved']), seq, issue(1223, ['couchy-ux/approved']), issue(1224, ['couchy-ux/approved', 'swarm/agent/grok'])];
  const subIssues = { 1412: [1223, 1224] };
  const theirs = pull(60, ['swarm/pr'], { body: 'Closes #9', created_at: ago(5) });
  const theirsFocus = pull(61, ['swarm/pr'], { body: 'Closes #1224', created_at: ago(1) });

  // A builder skips the review and the older unfocused issue, and takes the focused one.
  let gh = fake({ issues: issues(), subIssues, pulls: [theirs, theirsFocus] });
  let job = await next(gh, { me: 'codex-focus-1', role: 'focus' });
  assert.deepEqual([job.job, job.issue, job.focus], ['implement', 1223, 1412]);
  assert.deepEqual(gh.log, ['add 1223 swarm/agent/codex-focus-1']);
  // With nothing in focus left to take it stops, though #3 is free.
  job = await next(fake({ issues: [issue(3, ['couchy-ux/approved']), seq], pulls: [theirs] }), { me: 'codex-focus-1', role: 'focus' });
  assert.deepEqual([job.job, job.why], ['none', 'nothing in focus is claimable']);
  // A PR in focus that needs work comes first, whoever opened it; one outside focus is not a builder's.
  const mine = pull(62, ['swarm/pr'], { body: 'Closes #1223' });
  job = await next(fake({ issues: issues(), subIssues, pulls: [mine], checks: { sha62: [{ name: 'check', conclusion: 'failure' }] } }), { me: 'codex-focus-1', role: 'focus' });
  assert.deepEqual([job.job, job.pull], ['fix', 62]);
  job = await next(fake({ issues: [seq], subIssues, pulls: [theirs], checks: { sha60: [{ name: 'check', conclusion: 'failure' }] } }), { me: 'codex-focus-1', role: 'focus' });
  assert.equal(job.job, 'none');
  // It turns auto-merge on for a PR in focus where reviewed is required, and leaves the others.
  job = await next(fake({ issues: issues(), subIssues, pulls: [theirs, mine], required: ['reviewed'] }), { me: 'codex-focus-1', role: 'focus' });
  assert.deepEqual([job.job, job.pull], ['merge', 62]);

  // An ordinary tick reviews the PR in focus before an older one that isn't.
  job = await next(fake({ issues: issues(), subIssues, pulls: [theirs, theirsFocus] }), { me: 'codex' });
  assert.deepEqual([job.job, job.pull, job.focus], ['review', 61, true]);
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

/** Run an agent.mjs command on fake clients and read back the one line it wrote to TICK_EVENTS_FILE, less its time. */
async function tickEvent(clients, cmd, args = []) {
  const file = join(mkdtempSync(join(tmpdir(), 'tick-events-')), 'events.jsonl');
  const { out, event } = await run(cmd, args, { clients, me: 'codex', can: new Set(), role: 'all', ceiling: 45, minutes: 20, entry: 'agent.mjs' });
  await writeEvent(file, event);
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  const { at, ...line } = lines[0];
  assert.ok(at.endsWith('Z') && Math.abs(Date.parse(at) - Date.now()) < 60_000, at);
  return { out, line };
}

test('TICK_EVENTS_FILE: next writes the job it offered, with its title, and what it claimed', async () => {
  const home = 'getcouchy/couchy';
  const agent = 'getcouchy/couchy-agent';
  // The fewest requests left on any client, whichever has answered.
  const limited = (gh, left) => Object.assign(gh, { rateLimitRemaining: () => left });
  let { line } = await tickEvent([limited(fake({ issues: [issue(3)] }), 4900), limited(fake({ repo: agent }), 4870), limited(fake({ repo: 'o/r' }), null)], 'next');
  const three = { repo: home, number: 3, type: 'issue', title: 'Issue 3' };
  assert.deepEqual(line, { v: 1, cmd: 'next', job: 'implement', ...three, claimed: [three], rateLimitRemaining: 4870 });

  // A PR's job is on the PR; a fix takes its lock, a review takes none, and --look takes nothing.
  const red = { sha20: [{ name: 'check', conclusion: 'failure' }] };
  ({ line } = await tickEvent([fake({ pulls: [pull(20, ['swarm/pr'])], checks: red })], 'next'));
  const twenty = { repo: home, number: 20, type: 'pull', title: 'PR 20' };
  assert.deepEqual(line, { v: 1, cmd: 'next', job: 'fix', ...twenty, claimed: [twenty], rateLimitRemaining: null });
  ({ line } = await tickEvent([fake({ issues: [issue(3)] }), fake({ repo: agent, pulls: [pull(13, ['swarm/pr'])] })], 'next'));
  assert.deepEqual(line, { v: 1, cmd: 'next', job: 'review', repo: agent, number: 13, type: 'pull', title: 'PR 13', claimed: [], rateLimitRemaining: null });
  const looked = fake({ issues: [issue(3)] });
  ({ line } = await tickEvent([looked], 'next', ['--look']));
  assert.deepEqual([line.job, line.number, line.claimed, looked.log], ['implement', 3, [], []]);
  // A draft carried on is the PR's; my own lock on an issue with no PR is the issue's, held from now though taken before.
  ({ line } = await tickEvent([fake({ issues: [issue(1)], pulls: [pull(20, ['swarm/pr'], { draft: true, body: 'Closes #1' })] })], 'next'));
  assert.deepEqual([line.job, line.number, line.type, line.title, line.claimed], ['implement', 20, 'pull', 'PR 20', [twenty]]);
  const held = fake({ issues: [issue(4, ['couchy-ux/approved', 'swarm/focus', 'swarm/agent/codex'])] });
  ({ line } = await tickEvent([held], 'next'));
  const four = { repo: home, number: 4, type: 'issue', title: 'Issue 4' };
  assert.deepEqual([line.job, line.number, line.type, line.title, line.claimed, held.log], ['implement', 4, 'issue', 'Issue 4', [four], []]);

  // Nothing to do: why, and what was passed by in each repository.
  let out;
  ({ out, line } = await tickEvent([fake({ issues: [issue(4, ['couchy-ux/approved', 'swarm/focus', 'swarm/needs/design'])] }), fake({ repo: agent })], 'next'));
  assert.deepEqual(line, { v: 1, cmd: 'next', job: 'none', claimed: [], why: out.why, skipped: [{ repo: home, issue: 4, why: out.repos[0].skipped[0].why }], rateLimitRemaining: null });
  assert.match(line.skipped[0].why, /needs design/);
});

test('TICK_EVENTS_FILE: more and finish write what they released, with titles', async () => {
  const home = 'getcouchy/couchy';
  const mine = () => fake({ issues: [issue(1, ['couchy-ux/approved', 'swarm/agent/codex'])], pulls: [pull(50, ['swarm/pr', 'swarm/agent/codex'])] });
  const released = [{ repo: home, number: 1, type: 'issue', title: 'Issue 1' }, { repo: home, number: 50, type: 'pull', title: 'PR 50' }];
  let { out, line } = await tickEvent([mine()], 'more', [`--started=${new Date().toISOString()}`]);
  assert.deepEqual(line, { v: 1, cmd: 'more', job: 'review', repo: home, number: 50, type: 'pull', title: 'PR 50', released, rateLimitRemaining: null });
  assert.deepEqual(out.released, ['getcouchy/couchy#1', 'getcouchy/couchy#50'], 'what it prints is unchanged');
  ({ line } = await tickEvent([fake({ issues: [issue(3)] })], 'more', [`--started=${new Date(Date.now() - 3_600_000).toISOString()}`]));
  assert.deepEqual(line, { v: 1, cmd: 'more', job: 'none', released: [], why: '60 minutes into this tick (limit 20)', skipped: [], rateLimitRemaining: null });

  const agent = fake({ repo: 'getcouchy/couchy-agent', issues: [issue(12, ['couchy-ux/approved', 'swarm/agent/codex'])] });
  ({ out, line } = await tickEvent([mine(), agent], 'finish'));
  assert.deepEqual(line, { v: 1, cmd: 'finish', released: [...released, { repo: 'getcouchy/couchy-agent', number: 12, type: 'issue', title: 'Issue 12' }], rateLimitRemaining: null });
  assert.deepEqual(out, { finished: true, released: ['getcouchy/couchy#1', 'getcouchy/couchy#50', 'getcouchy/couchy-agent#12'] });
});

test('TICK_EVENTS_FILE: claim and release write the item, typed and titled, and the outcome', async () => {
  const agent = 'getcouchy/couchy-agent';
  const clients = () => [fake({ issues: [issue(3)] }), fake({ repo: agent, pulls: [pull(13, ['swarm/pr', 'swarm/agent/grok'], { pull_request: {} }), pull(14, ['swarm/pr', 'swarm/agent/codex'], { pull_request: {} })] })];
  let { out, line } = await tickEvent(clients(), 'claim', ['3']);
  const three = { repo: 'getcouchy/couchy', number: 3, type: 'issue', title: 'Issue 3' };
  assert.deepEqual(line, { v: 1, cmd: 'claim', ...three, claimed: [three], rateLimitRemaining: null });
  ({ out, line } = await tickEvent(clients(), 'claim', [`${agent}#13`]));
  assert.equal(out.claimed, false);
  assert.deepEqual(line, { v: 1, cmd: 'claim', repo: agent, number: 13, type: 'pull', title: 'PR 13', claimed: [], lost: true, rateLimitRemaining: null });

  const both = clients();
  ({ out, line } = await tickEvent(both, 'release', [`${agent}#14`, 'blocked on #9']));
  const fourteen = { repo: agent, number: 14, type: 'pull', title: 'PR 14' };
  assert.deepEqual(line, { v: 1, cmd: 'release', ...fourteen, released: [fourteen], rateLimitRemaining: null });
  assert.deepEqual(both[1].log, ['remove 14 swarm/agent/codex', 'comment 14']);

  // A title GitHub didn't give costs the field, not the line.
  ({ line } = await tickEvent([fake({ issues: [issue(3, undefined, { title: undefined })] })], 'claim', ['3']));
  const bare = { repo: 'getcouchy/couchy', number: 3, type: 'issue' };
  assert.deepEqual(line, { v: 1, cmd: 'claim', ...bare, claimed: [bare], rateLimitRemaining: null });
});

test('TICK_EVENTS_FILE: a pull request names its work item, and a work item its open pull requests', async () => {
  const home = 'getcouchy/couchy';
  const gh = () => fake({
    issues: [issue('COUCHYUX-7', ['couchy-ux/approved', 'swarm/focus', 'swarm/agent/codex'])],
    pulls: [
      pull(50, ['swarm/pr', 'swarm/agent/codex'], { body: 'Part of COUCHYUX-7 (1 of 2)' }),
      pull(51, ['swarm/pr'], { body: 'Closes COUCHYUX-7.', pull_request: {} }),
      pull(52, ['swarm/pr'], { body: 'Closes #3', pull_request: {} }),
    ],
  });
  const seven = { repo: home, number: 7, type: 'issue', key: 'COUCHYUX-7', title: 'Issue COUCHYUX-7', pulls: [50, 51] };
  const fifty = { repo: home, number: 50, type: 'pull', title: 'PR 50', workItem: 'COUCHYUX-7' };
  let { line } = await tickEvent([gh()], 'finish');
  assert.deepEqual(line, { v: 1, cmd: 'finish', released: [seven, fifty], rateLimitRemaining: null });

  // The command's own item carries it too; a PR that names no work item by key carries nothing.
  const one = { repo: home, number: 51, type: 'pull', title: 'PR 51', workItem: 'COUCHYUX-7' };
  ({ line } = await tickEvent([gh()], 'claim', ['51']));
  assert.deepEqual(line, { v: 1, cmd: 'claim', ...one, claimed: [one], rateLimitRemaining: null });
  ({ line } = await tickEvent([gh()], 'claim', ['52']));
  assert.deepEqual([line.workItem, line.pulls, line.claimed], [undefined, undefined, [{ repo: home, number: 52, type: 'pull', title: 'PR 52' }]]);

  // Open pull requests that can't be read cost the links, not the line.
  const closed = Object.assign(gh(), { openPulls: async () => { throw new Error('403'); } });
  ({ line } = await tickEvent([closed], 'release', ['COUCHYUX-7']));
  const bare = { repo: home, number: 7, type: 'issue', key: 'COUCHYUX-7' };
  assert.deepEqual(line, { v: 1, cmd: 'release', ...bare, released: [bare], rateLimitRemaining: null });
});

test('TICK_EVENTS_FILE unset: nothing is written or asked of GitHub; a failed write is not the command\'s', async () => {
  const gh = fake({ issues: [issue(3)] });
  let asked = 0;
  gh.issue = async () => { asked++; return issue(3); };
  const { out, event } = await run('release', ['3'], { clients: [gh], me: 'codex' });
  assert.deepEqual(out, { repo: 'getcouchy/couchy', issue: 3, released: true });
  await writeEvent(undefined, event);
  await writeEvent('', event);
  assert.equal(asked, 0);

  const errors = [];
  const error = console.error;
  console.error = (m) => errors.push(m);
  try {
    await writeEvent(join(mkdtempSync(join(tmpdir(), 'tick-events-')), 'missing', 'events.jsonl'), event);
  } finally {
    console.error = error;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^events: ENOENT/);
});

test('needs-human and hold: the comment, then the label, then the line the runner counts', async () => {
  const agent = 'getcouchy/couchy-agent';
  const comments = {};
  const home = fake({ issues: [issue(3)], comments });
  const other = fake({ repo: agent, pulls: [pull(13, ['swarm/pr'], { pull_request: {} })] });
  let { out, line } = await tickEvent([home, other], 'needs-human', ['3', 'Keep the old rows or drop them? I would keep them.']);
  assert.deepEqual(home.log, ['comment 3', 'add 3 swarm/needs-human'], 'the label pages with the latest comment, so it comes second');
  assert.equal(comments[3][0].body, 'Keep the old rows or drop them? I would keep them.\n\n<!-- agent: codex -->');
  assert.deepEqual(out, { repo: 'getcouchy/couchy', issue: 3, label: 'swarm/needs-human', commented: true, labelled: true });
  assert.deepEqual(line, { v: 1, cmd: 'needs-human', repo: 'getcouchy/couchy', number: 3, type: 'issue', title: 'Issue 3', rateLimitRemaining: null });

  ({ out, line } = await tickEvent([home, other], 'hold', [`${agent}#13`, 'Waits for #12 to merge.']));
  assert.deepEqual(other.log, ['comment 13', 'add 13 swarm/hold']);
  assert.deepEqual(line, { v: 1, cmd: 'hold', repo: agent, number: 13, type: 'pull', title: 'PR 13', rateLimitRemaining: null });

  // A step that fails stops it there, says how far it got, and writes nothing.
  const broken = (step) => Object.assign(fake({ issues: [issue(3)] }), { [step]: async () => { throw new Error(`${step}: 502`); } });
  let gh = broken('comment');
  let r = await run('needs-human', ['3', 'Which one?'], { clients: [gh], me: 'codex' });
  assert.deepEqual([r.out.commented, r.out.labelled, r.out.error, r.event, gh.log], [false, false, 'comment: 502', null, []], 'no label without its comment');
  gh = broken('addLabel');
  r = await run('hold', ['3', 'Waits for #12.'], { clients: [gh], me: 'codex' });
  assert.deepEqual([r.out.commented, r.out.labelled, r.out.error, r.event], [true, false, 'addLabel: 502', null]);

  await assert.rejects(run('hold', ['3'], { clients: [fake()], me: 'codex' }), UsageError, 'what it waits for is required');
  await assert.rejects(run('needs-human', ['nope', 'Which?'], { clients: [fake()], me: 'codex' }), UsageError);
  await assert.rejects(run('shaped', [], { clients: [fake()], me: 'codex' }), /submit needs a work item's key/, 'the old name of submit still runs it');
});

test('task breakdown: a task-breakdown tick takes what the owner labelled, in focus first, then by priority; builders leave it alone', async () => {
  const ask = (n, extra = {}) => issue(n, ['swarm/task-breakdown'], { stage: 'backlog', ...extra });
  assert.equal(requestKind(issue(1, ['swarm/task-breakdown', 'swarm/design'])), 'design', 'design breaks it down too');
  assert.equal(requestKind(issue(1)), null);
  assert.equal(whyNotBreakdown(ask(1)), null);
  assert.equal(whyNotBreakdown(ask(1, { stage: 'unstarted' })), null, 'Todo work can be broken down');
  assert.match(whyNotBreakdown(ask(1, { stage: 'started' })), /Backlog and Todo/);
  assert.match(whyNotBreakdown(issue(1, ['swarm/task-breakdown', 'swarm/agent/claude-1'], { stage: 'backlog' })), /held by claude-1/);
  assert.match(whyNotBreakdown(issue(1, ['swarm/design', 'swarm/needs-human'], { stage: 'backlog' })), /needs-human/);
  assert.match(whyNotClaimable(issue(1, ['swarm/focus', 'swarm/task-breakdown']), {}), /waiting for swarm\/task-breakdown/);

  const breakdown = { me: 'claude-task-breakdown-1', role: 'task-breakdown' };
  const queue = () => [
    ask(10, { priority: 'urgent' }),
    issue(11, ['swarm/design'], { stage: 'backlog', priority: 'low' }),
    issue(12, ['swarm/task-breakdown', 'swarm/focus'], { stage: 'backlog', priority: 'none' }),
    issue(13), // ready to build, but a task-breakdown tick builds nothing
  ];
  let job = await next(fake({ issues: queue() }), { ...breakdown, doClaim: false });
  assert.deepEqual([job.job, job.kind, job.issue, job.focus], ['task-breakdown', 'task-breakdown', 12, 12], 'in focus first, whatever its priority');
  const gh = fake({ issues: queue().filter((i) => i.number !== 12) });
  job = await nextAcross([gh], breakdown);
  assert.deepEqual([job.job, job.issue, job.claimed], ['task-breakdown', 10, true], 'then priority');
  assert.deepEqual(gh.log, ['add 10 swarm/agent/claude-task-breakdown-1']);
  job = await next(gh, breakdown);
  assert.deepEqual([job.issue, job.resumed], [10, true], 'its own comes back first');
  job = await next(fake({ issues: [issue(13), issue(14, ['swarm/task-breakdown'], { stage: 'started' })] }), breakdown);
  assert.deepEqual([job.job, job.why, job.skipped], ['none', 'nothing is waiting for task breakdown', [{ issue: 14, why: 'in started: task breakdown is for Backlog and Todo' }]]);
  // A builder skips a Todo item that is waiting for task breakdown.
  job = await next(fake({ issues: [issue(20, ['swarm/focus', 'swarm/design']), issue(21)] }), { me: 'claude-1', doClaim: false });
  assert.equal(job.issue, 21);
});

test('architect: an architect tick takes only swarm/tech-design work; a task-breakdown tick and a builder leave it alone', async () => {
  const td = (n, extra = {}) => issue(n, ['swarm/tech-design'], { stage: 'backlog', ...extra });
  assert.equal(requestKind(td(1)), 'tech-design');
  assert.equal(requestKind(issue(1, ['swarm/tech-design', 'swarm/task-breakdown'])), 'tech-design', 'the technical design comes before the breakdown');
  assert.equal(whyNotBreakdown(td(1)), null);
  assert.match(whyNotClaimable(issue(1, ['swarm/tech-design']), {}), /waiting for swarm\/tech-design/);

  const architect = { me: 'claude-architect-1', role: 'architect' };
  const queue = () => [td(30, { priority: 'low' }), issue(31, ['swarm/task-breakdown'], { stage: 'backlog', priority: 'urgent' }), issue(32)];
  let job = await next(fake({ issues: queue() }), { ...architect, doClaim: false });
  assert.deepEqual([job.job, job.kind, job.issue], ['task-breakdown', 'tech-design', 30], 'its own kind, whatever else is more urgent');
  const gh = fake({ issues: queue() });
  job = await next(gh, architect);
  assert.deepEqual([job.issue, job.claimed], [30, true]);
  assert.deepEqual(gh.log, ['add 30 swarm/agent/claude-architect-1']);
  job = await next(fake({ issues: queue() }), { me: 'claude-task-breakdown-1', role: 'task-breakdown', doClaim: false });
  assert.deepEqual([job.kind, job.issue], ['task-breakdown', 31], 'a task-breakdown tick never takes a technical design');
  job = await next(fake({ issues: [issue(31, ['swarm/task-breakdown'], { stage: 'backlog' })] }), architect);
  assert.deepEqual([job.job, job.why], ['none', 'nothing is waiting for a technical design'], 'and an architect takes nothing else');
  // A finished one keeps its label, in Review until its design PR merges: nobody takes it.
  const finished = () => [td(33, { stage: 'qa' })];
  for (const who of [architect, { me: 'claude-task-breakdown-1', role: 'task-breakdown' }, { me: 'claude-1' }]) {
    assert.equal((await next(fake({ issues: finished() }), { ...who, doClaim: false })).job, 'none');
  }
  // A builder skips a Todo item that waits for its technical design.
  job = await next(fake({ issues: [issue(40, ['swarm/focus', 'swarm/tech-design']), issue(41)] }), { me: 'claude-1', doClaim: false });
  assert.equal(job.issue, 41);
});

test('sweep: a task-breakdown lock on Backlog work is fine; the desk lists work waiting for task breakdown and broken-down work waiting for the owner', async () => {
  const issues = [
    issue(1, ['swarm/task-breakdown', 'swarm/agent/claude-task-breakdown-1'], { stage: 'backlog', updated_at: ago(1) }),
    issue(2, ['swarm/design'], { stage: 'backlog', updated_at: ago(6) }),
    issue(3, ['swarm/task-breakdown'], { stage: 'backlog', updated_at: ago(1) }), // not waiting long yet
    issue(4, ['swarm/needs-approval'], { stage: 'backlog' }),
    issue(5, ['swarm/needs-approval'], { stage: 'unstarted' }), // approved: in Todo
    issue(6, ['couchy-ux/approved', 'swarm/agent/claude-2'], { stage: 'backlog', updated_at: ago(1) }),
  ];
  const lockedAt = (name) => [{ event: 'labeled', label: { name }, created_at: ago(0.5) }];
  issues.push(issue(7, ['swarm/needs-approval'], { stage: 'needs-human' }));
  const gh = fake({ issues, closed: [issue(8, ['swarm/needs-approval'], { state: 'closed', stage: 'completed' })], events: { 1: lockedAt('swarm/agent/claude-task-breakdown-1'), 6: lockedAt('swarm/agent/claude-2') } });
  const { overdue } = await sweep(gh, { now: NOW, limits: LIMITS });
  assert.deepEqual(gh.log.filter((l) => l.includes('needs-approval')), ['remove 5 swarm/needs-approval', 'remove 8 swarm/needs-approval'], 'out of Backlog is approved; a question to the owner is not');
  const keys = overdue.map((o) => o.key);
  assert.ok(!keys.includes('unapproved:1'));
  assert.ok(keys.includes('unapproved:6'), 'a builder holding Backlog work still is');
  assert.deepEqual(overdue.filter((o) => o.section === 'Waiting for task breakdown').map((o) => o.line), ['#2 Issue 2 (design)']);
  assert.deepEqual(overdue.filter((o) => o.section === 'Waiting for your approval').map((o) => o.line), ['#4 Issue 4']);
});
