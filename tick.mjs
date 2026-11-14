// One agent's tick (see PROTOCOL.md): what should this agent do next? In
// order: fix a pull request that needs it, keep auto-merge right, review,
// carry on unfinished work, then start one approved issue. Takes a client from github.mjs, so tests pass a fake.

import { likelyWork } from './preflight.mjs';
import {
  AGENT_PREFIX, DESK, FOCUS, NIGHTLY, READY, REVIEWED, closingIssues, focus, partOfIssues, claimWinner, fixReasons, freeFor, handsOff, isReviewOnly, isReviewable, heartbeatId, heartbeatMarker,
  labelNames, linkedPulls, mergeHeld, mergeReady, needsReview, providers, whyNotClaimable,
} from './rules.mjs';

/**
 * Add the provider's label, then read the issue back: if another provider
 * labelled it at the same moment, the alphabetically first keeps it.
 * Returns true when `me` holds the issue.
 */
export async function claim(gh, number, me) {
  const before = await gh.issue(number);
  const holders = providers(before);
  if (holders.length && !holders.includes(me)) return false;
  await gh.addLabel(number, AGENT_PREFIX + me);
  if (gh.dryRun) return true;
  const after = await gh.issue(number);
  if (claimWinner(after) === me) return true;
  await gh.removeLabel(number, AGENT_PREFIX + me);
  return false;
}

export async function release(gh, number, me, reason) {
  await gh.removeLabel(number, AGENT_PREFIX + me);
  if (reason) await gh.comment(number, `Released by ${me}: ${reason}\n\n<!-- agent: ${me} -->`);
}

/** Record that this agent ran, as one comment per agent on the Agent desk issue. */
export async function heartbeat(gh, id, now = new Date()) {
  const [desk] = await gh.openIssues([DESK]);
  if (!desk) return; // the sweep creates it on its first run
  const body = `\`${id}\` last ticked ${now.toISOString()}\n\n${heartbeatMarker(id)}`;
  const mine = (await gh.comments(desk.number)).find((c) => heartbeatId(c) === id);
  if (mine) await gh.editComment(mine.id, body);
  else await gh.comment(desk.number, body);
}

/**
 * Whether a tick may start another job, and how long it has left. Until
 * `minutes` it keeps taking jobs; `ceiling` is its hard stop. A tick ends only
 * when its time is spent or nothing is left to do, never because one job is
 * finished. `left` (whole minutes to the ceiling) is for the agent to judge
 * the next job against: it starts one only if it will be done by then.
 */
export function mayContinue({ startedAt, now = Date.now(), minutes = 20, ceiling = 45 }) {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return { ok: false, why: 'no start time: pass --started with the time this tick began' };
  const spent = (now - started) / 60_000;
  const left = Math.max(0, Math.floor(ceiling - spent));
  if (spent >= minutes) return { ok: false, left, why: `${Math.round(spent)} minutes into this tick (limit ${minutes})` };
  return { ok: true, left };
}

/** Take `me`'s lock off everything it is on, at the end of a job or a tick. Returns what was released. */
export async function releaseAll(gh, me) {
  const mine = [...(await gh.openIssues()), ...(await gh.openPulls())].filter((i) => providers(i).includes(me));
  for (const item of mine) await gh.removeLabel(item.number, AGENT_PREFIX + me);
  return mine.map((i) => i.number);
}

/**
 * opts: { role: 'all' (default) or 'focus' (a builder: only what is in focus,
 * and no reviews), me: this agent's name, can: Set, doClaim: false to only
 * look, wrote: Set of PR numbers this session opened or pushed to }.
 * Returns { job: 'fix' | 'hold' | 'merge' | 'review' | 'implement' | 'none', ... }.
 * A job that changes code carries `lock`, the issue or PR number to put the
 * agent's label on while it works, and `claimed` once that is done.
 *
 * Nothing here belongs to an agent. A label is a lock on work in progress:
 * any agent may fix, continue or finish any of the swarm's PRs and issues
 * that nobody is on right now, since every session starts from the same
 * issue, PR and code whatever its name.
 */
export async function next(gh, { me, can = new Set(), doClaim = true, wrote = new Set(), role = 'all' }) {
  const builder = role === 'focus';
  const every = await gh.openPulls();
  // The swarm's PRs, and people's PRs marked `swarm/review-only`, which agents only review.
  const pulls = every.filter(isReviewable);
  const open = (await gh.openIssues()).filter((i) => !handsOff(i));
  const labelled = await gh.openIssues([FOCUS]);
  // A focused issue's sub-issues are in focus too, whether or not its body names them.
  const subs = new Map();
  for (const f of labelled) subs.set(f.number, await gh.subIssues(f.number));
  const focused = focus(labelled, subs);
  // A PR is in focus when an issue it closes, or is part of, is.
  const byNumber = new Map(open.map((i) => [i.number, i]));
  const pullFocus = (pr) => [...closingIssues(pr.body), ...partOfIssues(pr.body)].some((n) => byNumber.has(n) && focused.of(byNumber.get(n)));
  // With `reviewed` required on main, GitHub holds the merge for the verdict
  // itself, so auto-merge goes on as soon as a PR is open.
  const gated = (await gh.requiredChecks()).includes(REVIEWED);
  const lock = async (job) => {
    if (!doClaim) return job;
    return (await claim(gh, job.lock, me)) ? { ...job, claimed: true } : null; // null: another agent got there first
  };

  // What I am already on comes first: a lock of mine left from a tick that
  // died is work to pick back up. Then oldest first.
  const order = [...pulls.filter((p) => providers(p).includes(me)), ...pulls.filter((p) => !providers(p).includes(me))];
  const seen = [];
  for (const pr of order) {
    if (builder && !pullFocus(pr)) continue; // a builder leaves the rest to the other ticks
    const [checks, reviews, commit] = await Promise.all([gh.checks(pr.head.sha), gh.reviews(pr.number), gh.commit(pr.head.sha)]);
    seen.push({ pr, checks, reviews, pushedAt: commit.commit.committer.date });
  }

  // 1. A PR that needs work and that nobody is on: a failed check, a conflict,
  // changes requested. Whoever ticks first does it.
  for (const { pr, checks, reviews, pushedAt } of seen) {
    if (pr.draft || isReviewOnly(pr) || !freeFor(pr, me)) continue;
    const reasons = fixReasons(pr, { checks, reviews, pushedAt });
    if (!reasons.length) continue;
    const job = await lock({ job: 'fix', pull: pr.number, title: pr.title, branch: pr.head.ref, reasons, lock: pr.number });
    if (job) return job;
  }

  // 2. Then auto-merge, which is the default: off for a PR that is held but
  // has it on, on for one that should have it.
  // 3. Then a review, of a PR nobody is working on right now. The oldest PR
  // in focus, else the oldest of the rest; never one this session wrote.
  let toReview = null;
  for (const { pr, checks, reviews, pushedAt } of seen) {
    const held = !isReviewOnly(pr) && mergeHeld(pr, { reviews, checks, gated });
    if (held) return { job: 'hold', pull: pr.number, title: pr.title, why: held, how: 'turn auto-merge off' };
    if (!pr.auto_merge && mergeReady(pr, { reviews, checks, gated })) return { job: 'merge', pull: pr.number, title: pr.title, how: 'turn on auto-merge (squash)' };
    if (builder || pr.draft || wrote.has(pr.number) || !freeFor(pr, me)) continue;
    if (!needsReview(pr, reviews, pushedAt)) continue;
    const inFocus = pullFocus(pr);
    // A review-only PR is its author's: review it, give the verdict, and leave merging to them.
    const only = isReviewOnly(pr) ? { reviewOnly: true, how: 'review and give a verdict; push nothing and leave auto-merge alone' } : {};
    if (!toReview || (inFocus && !toReview.focus)) toReview = { job: 'review', pull: pr.number, title: pr.title, ...(inFocus ? { focus: true } : {}), ...only };
  }
  if (toReview) return toReview;

  // 4. Then unfinished work nobody is on: a draft PR, whoever opened it, or
  // an issue with my lock and no PR yet. Finishing comes before starting.
  // Any open PR for an issue means it is in progress, a person's PR included.
  const linked = linkedPulls(every);
  for (const { pr } of seen) {
    if (!pr.draft || isReviewOnly(pr) || !freeFor(pr, me)) continue;
    const job = await lock({ job: 'implement', pull: pr.number, issue: closingIssues(pr.body)[0] ?? partOfIssues(pr.body)[0] ?? null, title: pr.title, branch: pr.head.ref, resumed: true, lock: pr.number });
    if (job) return job;
  }
  const mine = open.find((i) => providers(i).includes(me) && !linked.get(i.number)?.length && (!builder || focused.of(i)));
  if (mine) return { job: 'implement', issue: mine.number, title: mine.title, resumed: true, lock: mine.number, claimed: true };

  // 5. Then one approved issue. What the owner marked `focus` goes to the
  // front of the queue, after main's failing simulator flows; a builder
  // takes nothing else.
  // Main's failing simulator flows (the nightly run's issue) come first: every
  // PR's simulator run is judged against them.
  const nightly = builder ? [] : await gh.openIssues([NIGHTLY]);
  const ready = [...nightly, ...focused.order(await gh.openIssues([READY])).filter((i) => !builder || focused.of(i))];
  const ctx = { can, linked };
  const skipped = [];
  for (const issue of ready) {
    const why = whyNotClaimable(issue, ctx);
    if (why) {
      if (!providers(issue).length) skipped.push({ issue: issue.number, why });
      continue;
    }
    const blockers = await gh.blockers(issue);
    if (blockers.length) {
      skipped.push({ issue: issue.number, why: `blocked by ${blockers.join(', ')}` });
      continue;
    }
    const job = await lock({ job: 'implement', issue: issue.number, title: issue.title, labels: labelNames(issue), lock: issue.number, ...(focused.of(issue) ? { focus: focused.of(issue) } : {}) });
    if (job) return job; // else lost the race: the next one
  }
  return { job: 'none', why: builder ? 'nothing in focus is claimable' : 'nothing claimable', skipped };
}

const ORDER = ['fix', 'hold', 'merge', 'review', 'implement'];

/**
 * `next` over several repositories (couchy and couchy-agent): the job that
 * comes first in the tick's order, wherever it is, with its `repo`. clients:
 * one github.mjs client per repository, the home repository (where the desk
 * is) first. opts as for `next`, with `wrote` a Map of repo -> Set. A
 * repository this token can't read is skipped and named. Nothing limits how many issues are in flight: an agent is on one thing at a time.
 */
export async function nextAcross(clients, { doClaim = true, wrote = new Map(), ...opts }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let best = null;
    const idle = [];
    for (const gh of clients) {
      let job;
      try {
        job = await next(gh, { ...opts, doClaim: false, wrote: wrote.get(gh.repo) ?? new Set() });
      } catch (e) {
        if (e.status !== 403 && e.status !== 404) throw e;
        job = { job: 'none', why: `can't read it (${e.status})` };
      }
      if (job.job === 'none') idle.push({ repo: gh.repo, why: job.why, skipped: job.skipped });
      // Among new issues, one in focus comes before one that isn't, whichever repository it is in.
      const rank = ORDER.indexOf(job.job) - (job.resumed ? 0.5 : job.focus ? 0.25 : 0);
      if (job.job !== 'none' && (!best || rank < best.rank)) best = { rank, gh, job };
    }
    if (!best) return { job: 'none', why: idle.map((i) => `${i.repo}: ${i.why}`).join('; '), repos: idle };
    const { gh, job } = best;
    if (job.lock && !job.claimed && doClaim) {
      if (!(await claim(gh, job.lock, opts.me))) continue; // lost the race: look again
      job.claimed = true;
    }
    return { repo: gh.repo, ...job };
  }
  return { job: 'none', why: 'lost three claims in a row to other agents' };
}

/**
 * The first job of a tick, given what the preflight found (preflight.mjs).
 * A checkout that was left alone is the job: it holds work nobody has
 * published, so the tick claims nothing and offers nothing else until the
 * agent has dealt with it and started again from a clean main.
 * gh: the home repository's client; clients: all of them.
 */
export async function firstJob(clients, checkout, opts) {
  if (checkout?.state !== 'left') return nextAcross(clients, opts);
  const [gh] = clients;
  const [pulls, issues] = await Promise.all([gh.openPulls(), gh.openIssues()]);
  return {
    job: 'checkout',
    ...checkout,
    ...likelyWork(checkout, { me: opts.me, pulls, issues, linked: linkedPulls(pulls) }),
    then: 'When this checkout is a clean main at origin/main (or you have moved to a fresh worktree of it), run next again.',
  };
}
