#!/usr/bin/env node
// The check on the multi-provider agent protocol (see PROTOCOL.md and the
// home repository's docs/ci.md, "Agent sweep"). Agents fail silently: a provider runs out of
// quota mid-issue, a scheduler gets logged out, a PR waits for a review nobody
// was told about. Each run is a full sweep that
//   - frees what it safely can: a lock two agents hold at once, and a lock
//     (a swarm/agent/<name> label, on an issue or a PR) left on for longer
//     than a tick can last;
//   - rewrites the "Agent desk" issue with everything else that is overdue, and
//     comments there once for each newly overdue item, so watching that one
//     issue is enough.
//
// It ends by pushing what it found as Prometheus metrics (docs/metrics.md)
// when SWARM_PUSHGATEWAY_URL is set.
//
// Needs GITHUB_TOKEN (issues write; pull requests and checks read) and
// GITHUB_REPOSITORY. DRY_RUN=true logs what it would change.
// DESK_COMMENTS=false leaves the comments out.

import { pathToFileURL } from 'node:url';
import { fromEnv } from './github.mjs';
import { pushRun } from './metrics.mjs';
import {
  AGENT_PREFIX, CONFLICT, DESK, FOCUS, HANDS_OFF, HOLD, REVIEW_ONLY, SWARM_PR, NEEDS_HUMAN, READY, REVIEWED, SQUAD, STAGES, EPIC, agentOf, canonical, claimWinner, fixReasons,
  heartbeatId, isReviewOnly, isReviewable, isSwarmPull, pullState, freeFor, lockLapsed, hoursSince, lastVerdict, mergeHeld, mergeReady, needsReview, labelNames, linkedPulls,
  providers, whyNotClaimable, FAILED, NIGHTLY,
} from './rules.mjs';

// GitHub refuses a label description over 100 characters, and a refused
// label fails the sweep, so the tests hold these to that.
export const LABELS = [
  [`${AGENT_PREFIX}claude`, '5319e7', 'A Claude agent is working on this right now. A lock, not ownership; see PROTOCOL.md.'],
  [`${AGENT_PREFIX}codex`, '5319e7', 'A Codex agent is working on this right now. A lock, not ownership; see PROTOCOL.md.'],
  [`${AGENT_PREFIX}grok`, '5319e7', 'A Grok agent is working on this right now. A lock, not ownership; see PROTOCOL.md.'],
  [NEEDS_HUMAN, 'd93f0b', 'An agent is stuck here and needs a person. Agents skip it until the label comes off.'],
  [HOLD, 'fbca04', 'An agent is holding this PR from auto-merge; its comment says why and what lifts it.'],
  [FOCUS, 'b60205', 'The owner\'s priority. Issues that carry this, mention it or are listed by it are built first.'],
  [HANDS_OFF, '000000', 'The owner is handling this. No agent starts, fixes, continues, reviews or merges it.'],
  [SWARM_PR, 'c5def5', 'A pull request the agents opened. It is theirs to review, fix, continue and merge.'],
  [REVIEW_ONLY, 'bfdadc', 'A person\'s pull request the agents review but never fix, continue or merge. See PROTOCOL.md.'],
  [DESK, 'ededed', 'The Agent desk issue, rewritten by the Agent sweep workflow.'],
];

/**
 * Moves labels still under their names from before the `swarm/` namespace
 * (agent/codex, needs-human, merge/hold, focus, agent-desk, needs/ios-sim) to
 * today's. A rename keeps the label on everything that carries it, closed
 * issues included. When today's label already exists, the old one is a
 * straggler an agent added from memory or an old checkout: each open item is
 * moved across. Returns the lines to report.
 */
export async function migrateLabels(gh) {
  const names = (await gh.labels()).map((l) => l.name);
  const moved = [];
  for (const old of names.filter((n) => canonical(n) !== n)) {
    const now = canonical(old);
    if (!names.includes(now)) {
      await gh.renameLabel(old, now);
      names.push(now);
      moved.push(`Label \`${old}\` is now \`${now}\`.`);
      continue;
    }
    for (const item of await gh.labelled(old)) {
      await gh.addLabel(item.number, now);
      await gh.removeLabel(item.number, old);
      moved.push(`#${item.number}: \`${old}\` replaced with \`${now}\`.`);
    }
  }
  return moved;
}

const STATE = /<!-- agent-desk-state: (.*?) -->/s;

// An event keeps the name its label had at the time, so old names are read as today's.
const lastEvent = (events, type, test) =>
  events.filter((e) => e.event === type && test(canonical(e.label?.name ?? ''))).map((e) => e.created_at).sort().at(-1) ?? null;
const lastLabeled = (events, test) => lastEvent(events, 'labeled', test);
const age = (h) => (h >= 48 ? `${Math.round(h / 24)} days` : `${Math.round(h)} hours`);

/**
 * limits: { claim (minutes), ready, review, fix, hold, heartbeat } in hours.
 * Returns what the desk shows, { fixed: [line], overdue: [{ key, section, line }], desk },
 * and the same facts for the metrics (docs/metrics.md):
 *   overdue[]    also { kind, number, agent, since }: the key's prefix, the item
 *                (null for a quiet agent), who it is with, and when its wait began
 *   pulls        [{ number, state, agent }], every PR the agents work on or review
 *   issues       [{ number, state: 'claimable' | 'locked', agent }], approved issues
 *   locks        [{ number, agent, type: 'issue' | 'pull', since }], still on after this run
 *   heartbeats   [{ agent, at }]
 *   fixedCounts  { lock_lapsed, lock_doubled }
 *   labelled     { needsHuman: [{ number, type, agent }], hold: [{ number, agent }] }
 */
export async function sweep(gh, { now = Date.now(), limits }) {
  const fixed = [];
  const overdue = [];
  const flag = (section, key, line, { number = null, agent = '', since = null } = {}) =>
    overdue.push({ section, key, line, kind: key.split(':')[0], number, agent, since });
  const typeOf = (item) => (item.pull_request || item.head ? 'pull' : 'issue');
  let locks = [];
  const fixedCounts = { lock_lapsed: 0, lock_doubled: 0 };
  const states = new Map(); // PR number -> its state, where a loop below worked it out

  const [issues, pulls] = await Promise.all([gh.openIssues(), gh.openPulls()]);
  const linked = linkedPulls(pulls);
  const gated = (await gh.requiredChecks()).includes(REVIEWED);
  const released = new Set(); // freed in this run: their wait starts now

  // Every PR an agent has touched keeps `swarm/pr`, so it stays the swarm's once the lock is off.
  // A review-only PR stays its author's, whoever is on it.
  for (const pr of pulls.filter((p) => providers(p).length && !isReviewOnly(p) && !labelNames(p).includes(SWARM_PR))) {
    await gh.addLabel(pr.number, SWARM_PR);
    if (!labelNames(pr).includes(SWARM_PR)) pr.labels = [...pr.labels, { name: SWARM_PR }];
  }

  // Locks that outlived any tick: the agent crashed, ran dry or forgot. The
  // label comes off, on an issue or a PR, and the work is anyone's again.
  for (const item of [...issues, ...pulls].filter((i) => providers(i).length)) {
    const events = await gh.events(item.number);
    for (const holder of providers(item)) {
      const lockedAt = lastLabeled(events, (n) => n === AGENT_PREFIX + holder);
      if (!lockLapsed({ lockedAt, now, minutes: limits.claim })) {
        locks.push({ number: item.number, agent: holder, type: typeOf(item), since: lockedAt });
        continue;
      }
      fixedCounts.lock_lapsed += 1;
      await gh.removeLabel(item.number, AGENT_PREFIX + holder);
      fixed.push(`#${item.number}: ${holder}'s lock had been on for over ${limits.claim} minutes; removed.`);
      item.labels = item.labels.filter((l) => canonical(l.name ?? l) !== AGENT_PREFIX + holder);
      if (!item.pull_request && !item.head) released.add(item.number);
    }
  }
  // Doubled locks.
  for (const issue of issues.filter((i) => providers(i).length)) {
    const held = providers(issue);
    for (const loser of held.filter((p) => p !== claimWinner(issue))) {
      await gh.removeLabel(issue.number, AGENT_PREFIX + loser);
      fixed.push(`#${issue.number}: ${held.join(' and ')} both held it; ${claimWinner(issue)} keeps it.`);
      fixedCounts.lock_doubled += 1;
      locks = locks.filter((l) => !(l.number === issue.number && l.agent === loser));
    }
    const holder = claimWinner(issue);
    if (!labelNames(issue).includes(READY)) {
      flag('Claims', `unapproved:${issue.number}`, `#${issue.number} is held by ${holder} but is not \`${READY}\`.`, { number: issue.number, agent: holder });
    }
  }

  // The queue: approved, unblocked, and nobody has taken it.
  const ctx = { can: { has: () => true }, linked };
  for (const issue of issues.filter((i) => !released.has(i.number) && !whyNotClaimable(i, ctx))) {
    // Ready since it was approved, or since an agent last let go of it.
    const events = await gh.events(issue.number);
    const since = [lastLabeled(events, (n) => n === READY), lastEvent(events, 'unlabeled', (n) => n.startsWith(AGENT_PREFIX))]
      .filter(Boolean).sort().at(-1) ?? issue.created_at;
    const waited = hoursSince(since, now);
    if (waited <= limits.ready) continue;
    if ((await gh.blockers(issue)).length) continue;
    flag('Waiting for an agent', `ready:${issue.number}`, `#${issue.number} has been ready for ${age(waited)} and no agent has taken it.`, { number: issue.number, since });
  }

  // Pull requests an agent opened.
  // Unfinished work nobody is on: a draft PR, with no push for a while.
  for (const pr of pulls.filter((p) => isSwarmPull(p) && p.draft && !providers(p).length)) {
    const pushedAt = (await gh.commit(pr.head.sha)).commit.committer.date;
    if (hoursSince(pushedAt, now) > limits.fix) {
      flag('Unfinished work nobody is on', `draft:${pr.number}`, `#${pr.number} is a draft with no push for ${age(hoursSince(pushedAt, now))} and no agent on it.`, { number: pr.number, agent: agentOf(pr), since: pushedAt });
    }
  }

  // A person's PR marked review-only is only ever late for its review.
  for (const pr of pulls.filter((p) => isReviewOnly(p) && !p.draft)) {
    const [reviews, commit] = await Promise.all([gh.reviews(pr.number), gh.commit(pr.head.sha)]);
    const pushedAt = commit.commit.committer.date;
    states.set(pr.number, pullState(pr, { reviews, pushedAt, gated }));
    const waitingSince = lastVerdict(pr, reviews) ? pushedAt : pr.created_at;
    if (needsReview(pr, reviews, pushedAt) && hoursSince(waitingSince, now) > limits.review) {
      flag('Pull requests waiting for review', `review:${pr.number}`, lastVerdict(pr, reviews)
        ? `#${pr.number} (review-only) has waited ${age(hoursSince(pushedAt, now))} for another review since its author pushed.`
        : `#${pr.number} (review-only) has been open ${age(hoursSince(pr.created_at, now))} with no review from an agent.`,
      { number: pr.number, agent: agentOf(pr), since: waitingSince });
    }
  }

  for (const pr of pulls.filter((p) => isSwarmPull(p) && !p.draft)) {
    const author = providers(pr)[0] ?? 'nobody on it';
    const [reviews, checks, commit] = await Promise.all([gh.reviews(pr.number), gh.checks(pr.head.sha), gh.commit(pr.head.sha)]);
    const pushedAt = commit.commit.committer.date;
    const reasons = fixReasons(pr, { checks, reviews, pushedAt });
    const item = { number: pr.number, agent: agentOf(pr) };
    states.set(pr.number, pullState(pr, { reviews, checks, pushedAt, gated }));
    if (mergeHeld(pr, { reviews, checks, gated })) {
      flag('Pull requests set to merge that should not be', `held:${pr.number}`, `#${pr.number} (${author}) has auto-merge on, but ${mergeHeld(pr, { reviews, checks, gated })}.`, item);
    }
    if (labelNames(pr).includes(HOLD)) {
      const since = lastLabeled(await gh.events(pr.number), (n) => n === HOLD) ?? pr.created_at;
      if (hoursSince(since, now) > limits.hold) {
        flag('Pull requests held from merging', `hold:${pr.number}`, `#${pr.number} (${author}) has carried \`${HOLD}\` for ${age(hoursSince(since, now))}.`, { ...item, since });
      }
    }
    if (reasons.length) {
      // Its author's turn since the latest of: the push, the failure, the review, the conflict.
      const since = [
        pushedAt,
        ...checks.filter((c) => FAILED.has(c.conclusion)).map((c) => c.completed_at),
        ...reviews.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.submitted_at),
        labelNames(pr).includes(CONFLICT) ? lastLabeled(await gh.events(pr.number), (n) => n === CONFLICT) : null,
      ].filter(Boolean).sort().at(-1);
      if (hoursSince(since, now) > limits.fix) {
        flag('Pull requests that need work', `fix:${pr.number}`, `#${pr.number} (${author}): ${reasons.join('; ')}, and no push for ${age(hoursSince(since, now))}.`, { ...item, since });
      }
    }
    // Auto-merge is the default: off for longer than the limit is overdue.
    const mergeSince = lastVerdict(pr, reviews)?.at ?? pr.created_at;
    if (!reasons.length && !pr.auto_merge && mergeReady(pr, { reviews, checks, gated }) && hoursSince(mergeSince, now) > limits.review) {
      flag('Pull requests not set to merge', `merge:${pr.number}`, lastVerdict(pr, reviews)
        ? `#${pr.number} (${author}) was reviewed ok ${age(hoursSince(mergeSince, now))} ago and auto-merge is off.`
        : `#${pr.number} (${author}) has been open ${age(hoursSince(mergeSince, now))} and auto-merge is off.`, { ...item, since: mergeSince });
    }
    if (!reasons.length && needsReview(pr, reviews, pushedAt) && hoursSince(lastVerdict(pr, reviews) ? pushedAt : pr.created_at, now) > limits.review) {
      const again = lastVerdict(pr, reviews);
      flag('Pull requests waiting for review', `review:${pr.number}`, again
        ? `#${pr.number} (${author}) has waited ${age(hoursSince(pushedAt, now))} for another review since its author pushed.`
        : `#${pr.number} (${author}) has been open ${age(hoursSince(pr.created_at, now))} with no review from an agent or a person.`,
      { ...item, since: again ? pushedAt : pr.created_at });
    }
  }

  // Squad issues in two stages at once.
  for (const issue of issues) {
    const names = labelNames(issue);
    const stages = STAGES.filter((s) => names.includes(s));
    if (names.includes(SQUAD) && !names.includes(EPIC) && stages.length > 1) {
      flag('Labels', `stages:${issue.number}`, `#${issue.number} carries ${stages.map((s) => `\`${s}\``).join(' and ')}; it should have one.`, { number: issue.number, agent: agentOf(issue) });
    }
  }

  // Anything an agent handed to a person.
  const labelled = { needsHuman: [], hold: [] };
  for (const item of [...issues, ...pulls].filter((i) => labelNames(i).includes(NEEDS_HUMAN))) {
    const since = lastLabeled(await gh.events(item.number), (n) => n === NEEDS_HUMAN) ?? item.created_at;
    flag('Needs you', `human:${item.number}`, `#${item.number} ${item.title}`, { number: item.number, agent: agentOf(item), since });
    labelled.needsHuman.push({ number: item.number, type: typeOf(item), agent: agentOf(item) });
  }
  for (const pr of pulls.filter((p) => labelNames(p).includes(HOLD))) labelled.hold.push({ number: pr.number, agent: agentOf(pr) });

  // Agents that stopped ticking.
  const desk = issues.find((i) => labelNames(i).includes(DESK)) ?? null;
  const heartbeats = [];
  if (desk) {
    for (const c of await gh.comments(desk.number)) {
      const id = heartbeatId(c);
      if (id) heartbeats.push({ agent: id, at: c.updated_at });
    }
  }
  // An agent can have left more than one heartbeat comment; its newest is when it last ticked, and it gets one line.
  const newest = new Map();
  for (const h of heartbeats) if (!newest.has(h.agent) || Date.parse(h.at) > Date.parse(newest.get(h.agent))) newest.set(h.agent, h.at);
  for (const [id, at] of newest) {
    if (hoursSince(at, now) > limits.heartbeat) {
      flag('Agents not ticking', `quiet:${id}`, `\`${id}\` last ticked ${age(hoursSince(at, now))} ago. Check its scheduled task, or delete its comment below if it is retired.`, { agent: id, since: at });
    }
  }

  // An approved issue is locked or free to take. Blockers aren't asked about here: that would cost a request per issue.
  const approved = (i) => labelNames(i).includes(READY) || labelNames(i).includes(NIGHTLY);
  const issueStates = issues.filter(approved).flatMap((i) => {
    if (providers(i).length) return [{ number: i.number, state: 'locked', agent: claimWinner(i) }];
    return whyNotClaimable(i, ctx) ? [] : [{ number: i.number, state: 'claimable', agent: '' }];
  });
  const pullStates = pulls.filter(isReviewable)
    .map((pr) => ({ number: pr.number, state: states.get(pr.number) ?? (pr.draft ? 'draft' : 'waiting'), agent: agentOf(pr) }));
  return { fixed, overdue, desk, pulls: pullStates, issues: issueStates, locks, heartbeats, fixedCounts, labelled };
}

const COUNTERS = /<!-- swarm-counters: (.*?) -->/s;

/**
 * The totals behind swarm_needs_human_total and swarm_hold_total, and which
 * items carried each label at the last run. A run lasts seconds, so they are
 * kept in the desk's body from one run to the next. `fresh` says there was
 * nothing to read: no marker yet, or one somebody broke by hand (JSON that
 * doesn't parse, or totals that aren't whole numbers).
 */
export function readCounters(body) {
  const totals = (t) => t && typeof t === 'object' && !Array.isArray(t) && Object.values(t).every((v) => Number.isSafeInteger(v) && v >= 0);
  const numbers = (list) => Array.isArray(list) && list.every(Number.isSafeInteger);
  try {
    const c = JSON.parse(COUNTERS.exec(body ?? '')[1]);
    if (!totals(c.needsHuman) || !totals(c.hold) || !numbers(c.labelled.needsHuman) || !numbers(c.labelled.hold)) throw new Error('not the shape countLabelled writes');
    return {
      needsHuman: { ...c.needsHuman }, hold: { ...c.hold },
      labelled: { needsHuman: [...c.labelled.needsHuman], hold: [...c.labelled.hold] }, fresh: false,
    };
  } catch {
    return { needsHuman: {}, hold: {}, labelled: { needsHuman: [], hold: [] }, fresh: true };
  }
}

/**
 * The counters after this run. An item that carries the label now and didn't
 * at the last run adds one, under `<type>|<agent>` for needs-human and the
 * agent for hold; one that lost the label and got it back counts again. A
 * fresh start only records who carries the labels: counting them would read
 * as that many handoffs in one run.
 */
export function countLabelled(prev, labelled) {
  const next = { needsHuman: { ...prev.needsHuman }, hold: { ...prev.hold }, labelled: { needsHuman: [], hold: [] } };
  const keyOf = { needsHuman: (i) => `${i.type}|${i.agent}`, hold: (i) => i.agent };
  for (const label of ['needsHuman', 'hold']) {
    for (const item of labelled[label]) {
      if (prev.fresh || prev.labelled[label].includes(item.number)) continue;
      next[label][keyOf[label](item)] = (next[label][keyOf[label](item)] ?? 0) + 1;
    }
    next.labelled[label] = labelled[label].map((i) => i.number).sort((a, b) => a - b);
  }
  return next;
}

export function deskBody(overdue, now, counters, { comments = true } = {}) {
  const sections = [...new Set(overdue.map((o) => o.section))];
  return [
    'What the agents (Claude, Codex, Grok…) are behind on, rewritten every hour by the Agent sweep workflow (see `PROTOCOL.md` in getcouchy/swarm). ' +
      (comments ? 'A comment is added once for each newly overdue item, so subscribing to this issue is enough. ' : '') +
      'The comments that say "last ticked" are the agents\' heartbeats; they edit their own.',
    '',
    ...(overdue.length
      ? sections.flatMap((s) => [`### ${s}`, '', ...overdue.filter((o) => o.section === s).map((o) => `- ${o.line}`), ''])
      : ['Nothing is overdue.', '']),
    `As of ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    '',
    `<!-- agent-desk-state: ${JSON.stringify(overdue.map((o) => o.key).sort())} -->`,
    ...(counters ? [`<!-- swarm-counters: ${JSON.stringify(counters)} -->`] : []),
  ].join('\n');
}

/**
 * Rewrites the desk (or opens it) and, unless `comments` is false, comments
 * once with what is newly overdue and what the sweep fixed. Returns the
 * counters it wrote into the body.
 */
export async function writeDesk(gh, { desk, overdue, fixed, labelled = { needsHuman: [], hold: [] }, now = Date.now(), comments = true }) {
  const counters = countLabelled(readCounters(desk?.body), labelled);
  const body = deskBody(overdue, now, counters, { comments });
  let seen = [];
  if (desk) {
    try {
      seen = JSON.parse(STATE.exec(desk.body ?? '')?.[1] ?? '[]');
    } catch {
      seen = []; // someone edited the body by hand; treat everything as new
    }
    await gh.editIssue(desk.number, { body });
  } else {
    desk = await gh.createIssue('Agent desk', body, [DESK]);
    if (!desk) return counters; // dry run
  }
  const fresh = overdue.filter((o) => !seen.includes(o.key));
  if (comments && (fresh.length || fixed.length)) {
    await gh.comment(desk.number, [
      ...(fresh.length ? ['Newly overdue:', '', ...fresh.map((o) => `- ${o.line}`), ''] : []),
      ...(fixed.length ? ['Fixed by the sweep:', '', ...fixed.map((f) => `- ${f}`)] : []),
    ].join('\n').trim());
  }
  return counters;
}

/**
 * Fills a metrics.mjs registry from one run: `result` from sweep(), `counters`
 * from writeDesk(), `migrated` the number of labels migrateLabels() moved.
 * Limits go out in seconds whatever unit they came in.
 */
export function sweepMetrics(reg, { result, counters, migrated = 0, limits, now = Date.now(), startedAt = now, rateLimit = null }) {
  const seconds = (since) => (since ? (now - Date.parse(since)) / 1000 : 0);
  const n = (number) => (number == null ? '' : String(number));
  // An agent can have left more than one heartbeat comment; its newest is when it last ticked.
  const ticked = new Map();
  for (const h of result.heartbeats) ticked.set(h.agent, Math.max(ticked.get(h.agent) ?? 0, Date.parse(h.at) / 1000));
  for (const [agent, at] of ticked) reg.set('swarm_agent_last_tick_timestamp_seconds', { agent }, at);
  for (const p of result.pulls) reg.set('swarm_pulls', { number: n(p.number), state: p.state, agent: p.agent }, 1);
  for (const i of result.issues) reg.set('swarm_issues', { number: n(i.number), state: i.state, agent: i.agent }, 1);
  for (const l of result.locks) reg.set('swarm_lock_age_seconds', { number: n(l.number), agent: l.agent, type: l.type }, seconds(l.since));
  for (const o of result.overdue) reg.set('swarm_overdue_age_seconds', { number: n(o.number), kind: o.kind, agent: o.agent }, seconds(o.since));
  for (const [limit, value] of Object.entries(limits)) reg.set('swarm_limit_seconds', { limit }, value * (limit === 'claim' ? 60 : 3600));
  for (const [action, count] of Object.entries({ ...result.fixedCounts, label_migrated: migrated })) reg.set('swarm_sweep_fixed', { action }, count);
  // increase() reads nothing from a series that first appears at 1, so each
  // agent this run saw (and '', an item with nobody on it) has its counters
  // out at 0 before anything is counted under it. Only an agent first seen in
  // the very run that counts it loses that one.
  const agents = new Set(['', ...[...result.pulls, ...result.issues, ...result.locks].map((i) => i.agent)]);
  const needsHuman = { ...Object.fromEntries([...agents].flatMap((a) => [[`issue|${a}`, 0], [`pull|${a}`, 0]])), ...counters.needsHuman };
  for (const [key, total] of Object.entries(needsHuman)) {
    const [type, ...agent] = key.split('|');
    reg.set('swarm_needs_human_total', { type, agent: agent.join('|') }, total);
  }
  const hold = { ...Object.fromEntries([...agents].map((a) => [a, 0])), ...counters.hold };
  for (const [agent, total] of Object.entries(hold)) reg.set('swarm_hold_total', { agent }, total);
  reg.set('swarm_job_last_success_timestamp_seconds', {}, now / 1000);
  reg.set('swarm_job_duration_seconds', {}, (now - startedAt) / 1000);
  if (rateLimit !== null) reg.set('swarm_github_rate_limit_remaining', {}, rateLimit);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const startedAt = Date.now();
  const hours = (name, dflt) => Number(process.env[name] || dflt);
  const gh = fromEnv();
  // Old names first, so ensureLabel doesn't create today's label beside one that only needs renaming.
  const renamed = await migrateLabels(gh);
  for (const line of renamed) console.log(`renamed: ${line}`);
  for (const [name, color, description] of LABELS) await gh.ensureLabel(name, color, description);
  const limits = {
    claim: hours('CLAIM_MINUTES', 90),
    ready: hours('READY_HOURS', 4),
    review: hours('REVIEW_HOURS', 4),
    fix: hours('FIX_HOURS', 2),
    hold: hours('HOLD_HOURS', 24),
    heartbeat: hours('HEARTBEAT_HOURS', 8),
  };
  const result = await sweep(gh, { limits });
  for (const f of result.fixed) console.log(`fixed: ${f}`);
  for (const o of result.overdue) console.log(`overdue: ${o.line}`);
  // DESK_COMMENTS=false: the desk's body is still rewritten, but nothing is commented.
  const counters = await writeDesk(gh, { ...result, comments: process.env.DESK_COMMENTS !== 'false' });
  // Last, and never fatal: the sweep's own work is done by now.
  const fill = (reg) => sweepMetrics(reg, { result, counters, migrated: renamed.length, limits, startedAt, rateLimit: gh.rateLimitRemaining() });
  if (await pushRun({ fill, job: 'swarm_sweep', repository: gh.repo })) console.log('Pushed metrics.');
  console.log(`${result.fixed.length} fixed, ${result.overdue.length} overdue.`);
}
