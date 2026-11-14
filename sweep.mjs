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
// Needs GITHUB_TOKEN (issues write; pull requests and checks read) and
// GITHUB_REPOSITORY. DRY_RUN=true logs what it would change.

import { pathToFileURL } from 'node:url';
import { fromEnv } from './github.mjs';
import {
  AGENT_PREFIX, CONFLICT, DESK, FOCUS, HANDS_OFF, HOLD, REVIEW_ONLY, SWARM_PR, NEEDS_HUMAN, READY, REVIEWED, SQUAD, STAGES, EPIC, canonical, claimWinner, fixReasons,
  heartbeatId, isReviewOnly, isSwarmPull, freeFor, lockLapsed, hoursSince, lastVerdict, mergeHeld, mergeReady, needsReview, labelNames, linkedPulls,
  providers, whyNotClaimable, FAILED,
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
 * Returns { fixed: [line], overdue: [{ key, section, line }] }.
 */
export async function sweep(gh, { now = Date.now(), limits }) {
  const fixed = [];
  const overdue = [];
  const flag = (section, key, line) => overdue.push({ section, key, line });

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
      if (!lockLapsed({ lockedAt, now, minutes: limits.claim })) continue;
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
    }
    const holder = claimWinner(issue);
    if (!labelNames(issue).includes(READY)) {
      flag('Claims', `unapproved:${issue.number}`, `#${issue.number} is held by ${holder} but is not \`${READY}\`.`);
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
    flag('Waiting for an agent', `ready:${issue.number}`, `#${issue.number} has been ready for ${age(waited)} and no agent has taken it.`);
  }

  // Pull requests an agent opened.
  // Unfinished work nobody is on: a draft PR, with no push for a while.
  for (const pr of pulls.filter((p) => isSwarmPull(p) && p.draft && !providers(p).length)) {
    const pushedAt = (await gh.commit(pr.head.sha)).commit.committer.date;
    if (hoursSince(pushedAt, now) > limits.fix) {
      flag('Unfinished work nobody is on', `draft:${pr.number}`, `#${pr.number} is a draft with no push for ${age(hoursSince(pushedAt, now))} and no agent on it.`);
    }
  }

  // A person's PR marked review-only is only ever late for its review.
  for (const pr of pulls.filter((p) => isReviewOnly(p) && !p.draft)) {
    const [reviews, commit] = await Promise.all([gh.reviews(pr.number), gh.commit(pr.head.sha)]);
    const pushedAt = commit.commit.committer.date;
    if (needsReview(pr, reviews, pushedAt) && hoursSince(lastVerdict(pr, reviews) ? pushedAt : pr.created_at, now) > limits.review) {
      flag('Pull requests waiting for review', `review:${pr.number}`, lastVerdict(pr, reviews)
        ? `#${pr.number} (review-only) has waited ${age(hoursSince(pushedAt, now))} for another review since its author pushed.`
        : `#${pr.number} (review-only) has been open ${age(hoursSince(pr.created_at, now))} with no review from an agent.`);
    }
  }

  for (const pr of pulls.filter((p) => isSwarmPull(p) && !p.draft)) {
    const author = providers(pr)[0] ?? 'nobody on it';
    const [reviews, checks, commit] = await Promise.all([gh.reviews(pr.number), gh.checks(pr.head.sha), gh.commit(pr.head.sha)]);
    const pushedAt = commit.commit.committer.date;
    const reasons = fixReasons(pr, { checks, reviews, pushedAt });
    if (mergeHeld(pr, { reviews, checks, gated })) {
      flag('Pull requests set to merge that should not be', `held:${pr.number}`, `#${pr.number} (${author}) has auto-merge on, but ${mergeHeld(pr, { reviews, checks, gated })}.`);
    }
    if (labelNames(pr).includes(HOLD)) {
      const since = lastLabeled(await gh.events(pr.number), (n) => n === HOLD) ?? pr.created_at;
      if (hoursSince(since, now) > limits.hold) {
        flag('Pull requests held from merging', `hold:${pr.number}`, `#${pr.number} (${author}) has carried \`${HOLD}\` for ${age(hoursSince(since, now))}.`);
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
        flag('Pull requests that need work', `fix:${pr.number}`, `#${pr.number} (${author}): ${reasons.join('; ')}, and no push for ${age(hoursSince(since, now))}.`);
      }
    }
    // Auto-merge is the default: off for longer than the limit is overdue.
    const mergeSince = lastVerdict(pr, reviews)?.at ?? pr.created_at;
    if (!reasons.length && !pr.auto_merge && mergeReady(pr, { reviews, checks, gated }) && hoursSince(mergeSince, now) > limits.review) {
      flag('Pull requests not set to merge', `merge:${pr.number}`, lastVerdict(pr, reviews)
        ? `#${pr.number} (${author}) was reviewed ok ${age(hoursSince(mergeSince, now))} ago and auto-merge is off.`
        : `#${pr.number} (${author}) has been open ${age(hoursSince(mergeSince, now))} and auto-merge is off.`);
    }
    if (!reasons.length && needsReview(pr, reviews, pushedAt) && hoursSince(lastVerdict(pr, reviews) ? pushedAt : pr.created_at, now) > limits.review) {
      const again = lastVerdict(pr, reviews);
      flag('Pull requests waiting for review', `review:${pr.number}`, again
        ? `#${pr.number} (${author}) has waited ${age(hoursSince(pushedAt, now))} for another review since its author pushed.`
        : `#${pr.number} (${author}) has been open ${age(hoursSince(pr.created_at, now))} with no review from an agent or a person.`);
    }
  }

  // Squad issues in two stages at once.
  for (const issue of issues) {
    const names = labelNames(issue);
    const stages = STAGES.filter((s) => names.includes(s));
    if (names.includes(SQUAD) && !names.includes(EPIC) && stages.length > 1) {
      flag('Labels', `stages:${issue.number}`, `#${issue.number} carries ${stages.map((s) => `\`${s}\``).join(' and ')}; it should have one.`);
    }
  }

  // Anything an agent handed to a person.
  for (const item of [...issues, ...pulls].filter((i) => labelNames(i).includes(NEEDS_HUMAN))) {
    flag('Needs you', `human:${item.number}`, `#${item.number} ${item.title}`);
  }

  // Agents that stopped ticking.
  const desk = issues.find((i) => labelNames(i).includes(DESK)) ?? null;
  if (desk) {
    for (const c of await gh.comments(desk.number)) {
      const id = heartbeatId(c);
      if (id && hoursSince(c.updated_at, now) > limits.heartbeat) {
        flag('Agents not ticking', `quiet:${id}`, `\`${id}\` last ticked ${age(hoursSince(c.updated_at, now))} ago. Check its scheduled task, or delete its comment below if it is retired.`);
      }
    }
  }
  return { fixed, overdue, desk };
}

export function deskBody(overdue, now) {
  const sections = [...new Set(overdue.map((o) => o.section))];
  return [
    'What the agents (Claude, Codex, Grok…) are behind on, rewritten every hour by the Agent sweep workflow (see `PROTOCOL.md` in getcouchy/swarm). ' +
      'A comment is added once for each newly overdue item, so subscribing to this issue is enough. ' +
      'The comments that say "last ticked" are the agents\' heartbeats; they edit their own.',
    '',
    ...(overdue.length
      ? sections.flatMap((s) => [`### ${s}`, '', ...overdue.filter((o) => o.section === s).map((o) => `- ${o.line}`), ''])
      : ['Nothing is overdue.', '']),
    `As of ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    '',
    `<!-- agent-desk-state: ${JSON.stringify(overdue.map((o) => o.key).sort())} -->`,
  ].join('\n');
}

export async function writeDesk(gh, { desk, overdue, fixed, now = Date.now() }) {
  const body = deskBody(overdue, now);
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
    if (!desk) return; // dry run
  }
  const fresh = overdue.filter((o) => !seen.includes(o.key));
  if (fresh.length || fixed.length) {
    await gh.comment(desk.number, [
      ...(fresh.length ? ['Newly overdue:', '', ...fresh.map((o) => `- ${o.line}`), ''] : []),
      ...(fixed.length ? ['Fixed by the sweep:', '', ...fixed.map((f) => `- ${f}`)] : []),
    ].join('\n').trim());
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const hours = (name, dflt) => Number(process.env[name] || dflt);
  const gh = fromEnv();
  // Old names first, so ensureLabel doesn't create today's label beside one that only needs renaming.
  const renamed = await migrateLabels(gh);
  for (const line of renamed) console.log(`renamed: ${line}`);
  for (const [name, color, description] of LABELS) await gh.ensureLabel(name, color, description);
  const result = await sweep(gh, {
    limits: {
      claim: hours('CLAIM_MINUTES', 90),
      ready: hours('READY_HOURS', 4),
      review: hours('REVIEW_HOURS', 4),
      fix: hours('FIX_HOURS', 2),
      hold: hours('HOLD_HOURS', 24),
      heartbeat: hours('HEARTBEAT_HOURS', 8),
    },
  });
  for (const f of result.fixed) console.log(`fixed: ${f}`);
  for (const o of result.overdue) console.log(`overdue: ${o.line}`);
  await writeDesk(gh, result);
  console.log(`${result.fixed.length} fixed, ${result.overdue.length} overdue.`);
}
