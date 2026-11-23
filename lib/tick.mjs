// One agent's tick (see PROTOCOL.md): what should this agent do next? In
// order: fix a pull request that needs it, keep auto-merge right, review,
// carry on unfinished work, then start one ready work item. Takes a client
// from workitems.mjs's tracker() (pull requests on GitHub, work items in the tracker),
// so tests pass a fake.

import { LabelGroupTaken, isKey } from './workitems.mjs';
import { likelyWork } from './preflight.mjs';
import {
  AGENT_PREFIX, DESK, FOCUS, REVIEWED, blockGraph, closingIssues, downstream, partOfIssues, priorityRank, claimWinner, fixReasons, freeFor, handsOff, isReady, isReviewOnly, isReviewable, heartbeatId, heartbeatMarker,
  labelNames, linkedPulls, linkedTo, mergeHeld, mergeReady, needsReview, openParents, providers, refsOf, requestKind, whyNotClaimable, whyNotBreakdown, REQUEST_KINDS,
} from './rules.mjs';

/**
 * Add the provider's label, then read the issue back: if another provider
 * labelled it at the same moment, the alphabetically first keeps it. Where
 * the locks are a group that takes one label (Linear's `swarm-agent`), the
 * tracker refuses the second instead, and that agent has lost.
 * Returns true when `me` holds the issue.
 */
export async function claim(gh, number, me) {
  const before = await gh.issue(number);
  const holders = providers(before);
  if (holders.length && !holders.includes(me)) return false;
  try {
    await gh.addLabel(number, AGENT_PREFIX + me);
  } catch (e) {
    if (e instanceof LabelGroupTaken) return false;
    throw e;
  }
  if (gh.dryRun) return true;
  const after = await gh.issue(number);
  if (claimWinner(after) === me) {
    // The board shows a claimed work item as In Progress; breaking it down is not building it.
    if (isKey(number) && after.stage === 'unstarted' && !requestKind(after)) await gh.setStage(number, 'started');
    return true;
  }
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

/**
 * Take `me`'s lock off everything it is on, at the end of a job or a tick.
 * Returns what was released, as [{ number, type: 'issue' | 'pull' }].
 */
export async function releaseAll(gh, me) {
  const held = (i) => providers(i).includes(me);
  const mine = [
    ...(await gh.openIssues()).filter(held).map((i) => ({ number: i.number, type: 'issue', title: i.title })),
    ...(await gh.openPulls()).filter(held).map((p) => ({ number: p.number, type: 'pull', title: p.title })),
  ];
  for (const item of mine) await gh.removeLabel(item.number, AGENT_PREFIX + me);
  return mine;
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
  if (REQUEST_KINDS[role]) return nextBreakdown(gh, { me, doClaim, kinds: REQUEST_KINDS[role] });
  const builder = role === 'focus';
  const every = await gh.openPulls();
  // The swarm's PRs, and people's PRs marked `swarm/review-only`, which agents only review.
  const pulls = every.filter(isReviewable);
  const open = (await gh.openIssues()).filter((i) => !handsOff(i));
  const focused = await focusOf(gh, open);
  // A PR is in focus when an item it closes, or is part of, is. It may name
  // the item by its key or by the GitHub issue it was copied from.
  const byRef = new Map(open.flatMap((i) => refsOf(i).map((r) => [r, i])));
  const pullFocus = (pr) => [...closingIssues(pr.body), ...partOfIssues(pr.body)].some((n) => byRef.has(n) && focused.of(byRef.get(n)));
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

  // 4. Then unfinished work in focus nobody is on: a draft PR, whoever opened
  // it, or an issue with my lock and no PR yet. Finishing comes before
  // starting. A draft for work outside focus waits: carrying it on is what
  // kept a paused chain of slices going. Any open PR for an issue means it is
  // in progress, a person's PR included.
  const linked = linkedPulls(every);
  for (const { pr } of seen) {
    if (!pr.draft || isReviewOnly(pr) || !freeFor(pr, me) || !pullFocus(pr)) continue;
    const ref = closingIssues(pr.body)[0] ?? partOfIssues(pr.body)[0] ?? null;
    const job = await lock({ job: 'implement', pull: pr.number, issue: byRef.get(ref)?.number ?? ref, title: pr.title, branch: pr.head.ref, resumed: true, lock: pr.number });
    if (job) return job;
  }
  const mine = open.find((i) => providers(i).includes(me) && !linkedTo(linked, i).length && focused.of(i));
  if (mine) return { job: 'implement', issue: mine.number, title: mine.title, ...url(mine), resumed: true, lock: mine.number, claimed: true, ...await returnedFrom(gh, mine) };

  // 5. Then one ready work item, and only one in focus: with none claimable
  // the tick has nothing to start. Highest priority first; between equals, the one more
  // work waits on.
  const ctx = { can, linked, parents: openParents(open) };
  const skipped = [];
  const candidates = [];
  for (const issue of open.filter((i) => isReady(i) && focused.of(i))) {
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
    candidates.push(issue);
  }
  for (const issue of await startOrder(gh, candidates, open)) {
    const job = await lock({ job: 'implement', issue: issue.number, title: issue.title, ...url(issue), labels: labelNames(issue), lock: issue.number, focus: focused.of(issue) });
    if (job) return { ...job, ...await returnedFrom(gh, issue) }; // else lost the race: the next one
  }
  return { job: 'none', why: 'nothing in focus is claimable', skipped };
}

/**
 * A task-breakdown tick's job (PROTOCOL.md, "Task-breakdown ticks"), or an architect's
 * (ARCHITECT.md) when `kinds` is its own: the work item it holds already,
 * else one the owner labelled for it (`swarm/task-breakdown` or `swarm/design`
 * for a task-breakdown tick, `swarm/tech-design` for an architect), those
 * in focus first, then by priority, then the one more work waits on. It
 * builds nothing and reviews nothing.
 */
export async function nextBreakdown(gh, { me, doClaim = true, kinds = REQUEST_KINDS['task-breakdown'] }) {
  const wanted = (i) => kinds.includes(requestKind(i));
  const open = (await gh.openIssues()).filter((i) => !handsOff(i));
  const job = (issue, extra) => ({ job: 'task-breakdown', kind: requestKind(issue), issue: issue.number, title: issue.title, ...url(issue), labels: labelNames(issue), lock: issue.number, ...extra });
  const mine = open.find((i) => wanted(i) && providers(i).includes(me));
  if (mine) return job(mine, { resumed: true, claimed: true });
  const skipped = [];
  const candidates = [];
  for (const issue of open.filter(wanted)) {
    const why = whyNotBreakdown(issue);
    if (why) skipped.push({ issue: issue.number, why });
    else candidates.push(issue);
  }
  const focused = await focusOf(gh, open);
  const inFocus = candidates.filter((i) => focused.of(i));
  const rest = candidates.filter((i) => !focused.of(i));
  for (const issue of [...await startOrder(gh, inFocus, open), ...await startOrder(gh, rest, open)]) {
    const offer = job(issue, focused.of(issue) ? { focus: focused.of(issue) } : {});
    if (!doClaim) return offer;
    if (await claim(gh, issue.number, me)) return { ...offer, claimed: true };
  }
  return { job: 'none', why: kinds.includes('tech-design') ? 'nothing is waiting for a technical design' : 'nothing is waiting for task breakdown', skipped };
}

// A blocker as `blockers` names it ('#21', 'COUCHYUX-9'), as an item's reference.
const blockerRef = (b) => (typeof b === 'string' && /^#\d+$/.test(b) ? Number(b.slice(1)) : b);

/**
 * What the owner put first: the open items in the current cycle (the sprint)
 * or labelled `swarm/focus`, their children (the parent link, three levels
 * down), and every open item one of those waits on, down the whole chain of
 * blockers, so a sprint item is never stuck behind work nobody will start.
 * Naming an item in a description puts nothing in focus.
 * open: the open work items. Returns { of(issue): the number of the focused
 * item that puts it in focus, or null }.
 */
export async function focusOf(gh, open) {
  const byRef = new Map(open.flatMap((i) => refsOf(i).map((r) => [r, i])));
  const owner = new Map();
  const queue = [];
  const add = (item, by) => {
    if (!item || owner.has(item.number)) return;
    for (const r of refsOf(item)) owner.set(r, by);
    queue.push(item);
  };
  const focused = await gh.openIssues([FOCUS]);
  for (const f of focused) add(f, f.number);
  for (const f of focused) for (const n of await gh.subIssues(f.number)) add(byRef.get(n), f.number);
  while (queue.length) {
    const item = queue.shift();
    for (const b of await gh.blockers(item)) add(byRef.get(blockerRef(b)), owner.get(item.number));
  }
  return { of: (issue) => refsOf(issue).map((r) => owner.get(r)).find((v) => v != null) ?? null };
}

/**
 * The order to start claimable work items in: priority, urgent first;
 * then the one more open work waits on, counted down the whole chain of
 * "Blocked by" lines and the tracker's blocking relations. Items equal on both keep
 * the order they came in.
 */
export async function startOrder(gh, candidates, open) {
  const blocks = blockGraph(open);
  const ranked = await Promise.all(candidates.map(async (issue) => ({
    issue,
    priority: priorityRank(issue),
    unblocks: downstream(blocks, issue.number, (await gh.blocking?.(issue)) ?? []).size,
  })));
  return ranked.sort((a, b) => a.priority - b.priority || b.unblocks - a.unblocks).map((r) => r.issue);
}

const ORDER = ['fix', 'hold', 'merge', 'review', 'implement', 'task-breakdown'];
const url = (item) => (item.html_url ? { url: item.html_url } : {});

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
const AGENT_MARKER = /<!-- agent(?:-heartbeat)?: /;

/**
 * Whether a work item came back from QA: a merged PR closes it, yet it is
 * open again, because the owner sent it back to Todo with a comment saying
 * which criterion failed (PROTOCOL.md, "Where the work is"). Then the job
 * carries `returned`: the PRs that shipped it, the people's comments since
 * the last of them merged, and how to go on, so the agent fixes what failed
 * rather than building the item again. {} for any other item. The merged PRs
 * are found among the item's links: the sweep links each PR it follows.
 */
export async function returnedFrom(gh, item) {
  if (!gh.links || !isKey(item.number)) return {};
  const numbers = [...new Set((await gh.links(item.number))
    .map((l) => PR_URL.exec(l.url ?? '')).filter((m) => m && m[1] === gh.repo).map((m) => Number(m[2])))];
  const refs = refsOf(item);
  const merged = [];
  for (const n of numbers) {
    const pr = await gh.pull(n);
    if (pr?.merged_at && closingIssues(pr.body).some((r) => refs.includes(r))) merged.push({ pull: n, url: pr.html_url, merged_at: pr.merged_at });
  }
  if (!merged.length) return {};
  merged.sort((a, b) => a.merged_at.localeCompare(b.merged_at));
  const since = merged.at(-1).merged_at;
  const feedback = (await gh.comments(item.number))
    .filter((c) => c.created_at > since && !AGENT_MARKER.test(c.body ?? ''))
    .map((c) => ({ at: c.created_at, text: c.body }));
  const shipped = merged.map((p) => `#${p.pull}`).join(', ');
  const how = feedback.length
    ? `This came back from QA: ${shipped} shipped it, and the feedback says what failed. Fix only that, on a fresh branch from main, in a new PR that says "Closes ${item.number}"; don't build again what already shipped.`
    : `This came back from QA after ${shipped} merged, but no comment since says what failed. Don't guess: ask with agent.mjs needs-human ${item.number} "<which criterion failed?>".`;
  return { returned: { pulls: merged, feedback, how } };
}

/**
 * `next` over several repositories (couchy and couchy-agent): the job that
 * comes first in the tick's order, wherever it is, with its `repo`. clients:
 * one github.mjs client per repository, the home repository (where the desk
 * is) first. opts as for `next`, with `wrote` a Map of repo -> Set. A
 * repository this token can't read is skipped and named. Nothing limits how many issues are in flight: an agent is on one thing at a time.
 * onClaim(repo, job) is called when the job comes with my lock on it: taken
 * now, or left from an earlier tick and picked back up.
 */
export async function nextAcross(clients, { doClaim = true, wrote = new Map(), onClaim, ...opts }) {
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
    if (job.claimed) onClaim?.(gh.repo, job);
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
