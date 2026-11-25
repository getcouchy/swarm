// One agent's tick (see PROTOCOL.md): what should this agent do next? In
// order: fix a pull request that needs it, keep auto-merge right, review,
// carry on unfinished work, then start one ready work item. Takes a client
// from workitems.mjs's tracker() (pull requests on GitHub, work items in the tracker),
// so tests pass a fake.

import { LabelGroupTaken, isKey } from './workitems.mjs';
import { likelyWork } from './preflight.mjs';
import {
  AGENT_PREFIX, BASE_BRANCH, DESK, FOCUS, MERGE_METHOD, REVIEWED, blockGraph, closingIssues, downstream, partOfIssues, priorityRank, claimWinner, fixReasons, freeFor, handsOff, isReady, isReviewOnly, isReviewable, heartbeatId, heartbeatMarker,
  labelNames, linkedPulls, linkedTo, mergeHeld, mergeReady, needsReview, openParents, providers, refsOf, requestKind, splitFrom, whyNotClaimable, whyNotBreakdown, REQUEST_KINDS,
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
    // A merged one too: auto-merge can land it while its lock is still on.
    ...[...await gh.openPulls(), ...await gh.closedPulls()].filter(held).map((p) => ({ number: p.number, type: 'pull', title: p.title })),
  ];
  for (const item of mine) await gh.removeLabel(item.number, AGENT_PREFIX + me);
  return mine;
}

/**
 * opts: { role: 'general' (default) or 'builder' (only what is in focus,
 * and no reviews), me: this agent's name, can: Set, doClaim: false to only
 * look, wrote: Set of PR numbers this session opened or pushed to, skip: Set
 * of what this session passed over: work items' keys and 'owner/name#57' }.
 * Returns { job: 'fix' | 'hold' | 'merge' | 'review' | 'implement' | 'none', ... }.
 * A job that changes code carries `lock`, the issue or PR number to put the
 * agent's label on while it works, and `claimed` once that is done.
 *
 * Nothing here belongs to an agent. A label is a lock on work in progress:
 * any agent may fix, continue or finish any of the swarm's PRs and issues
 * that nobody is on right now, since every session starts from the same
 * issue, PR and code whatever its name.
 */
export async function next(gh, { me, can = new Set(), doClaim = true, wrote = new Set(), skip = new Set(), role = 'general' }) {
  if (REQUEST_KINDS[role]) return nextBreakdown(gh, { me, doClaim, skip, kinds: REQUEST_KINDS[role] });
  const passed = passedOver(gh, skip);
  const builder = role === 'builder';
  const every = await gh.openPulls();
  // The swarm's PRs, and people's PRs marked `swarm/review-only`, which agents only review.
  const pulls = every.filter(isReviewable);
  const issues = await gh.openIssues();
  const open = issues.filter((i) => !handsOff(i));
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
    if (pr.draft || isReviewOnly(pr) || !freeFor(pr, me) || passed(pr)) continue;
    const reasons = fixReasons(pr, { checks, reviews, pushedAt });
    if (!reasons.length) continue;
    const job = await lock({ job: 'fix', pull: pr.number, title: pr.title, branch: pr.head.ref, reasons, lock: pr.number });
    if (job) return job;
  }

  // 2. Then auto-merge, which is the default: off for a PR that is held but
  // has it on, on for one that should have it.
  // 3. Then a review, of a PR nobody is working on right now. The oldest PR
  // in focus, else the oldest of the rest; never one this session wrote.
  // Passing over a PR doesn't stop auto-merge being put right: left on, it can
  // merge held work.
  let toReview = null;
  for (const { pr, checks, reviews, pushedAt } of seen) {
    const held = !isReviewOnly(pr) && mergeHeld(pr, { reviews, checks, gated });
    if (held) return { job: 'hold', pull: pr.number, title: pr.title, why: held, how: 'turn auto-merge off' };
    if (!pr.auto_merge && mergeReady(pr, { reviews, checks, gated })) return { job: 'merge', pull: pr.number, title: pr.title, how: `turn on auto-merge (${MERGE_METHOD})` };
    if (builder || pr.draft || wrote.has(pr.number) || passed(pr) || !freeFor(pr, me)) continue;
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
    if (passed(pr) || (ref !== null && passed(byRef.get(ref) ?? { number: ref }))) continue;
    const job = await lock({ job: 'implement', pull: pr.number, issue: byRef.get(ref)?.number ?? ref, title: pr.title, branch: pr.head.ref, ...partOf(byRef.get(ref), open), resumed: true, lock: pr.number });
    if (job) return job;
  }
  const mine = open.find((i) => providers(i).includes(me) && !linkedTo(linked, i).length && focused.of(i) && !passed(i));
  if (mine) return { job: 'implement', issue: mine.number, title: mine.title, ...url(mine), ...partOf(mine, open), resumed: true, lock: mine.number, claimed: true, ...await returnedFrom(gh, mine) };

  // 5. Then one ready work item, and only one in focus: with none claimable
  // the tick has nothing to start. Highest priority first; between equals, the one more
  // work waits on.
  const ctx = { can, linked, parents: openParents(issues) };
  const skipped = [];
  const candidates = [];
  for (const issue of open.filter((i) => isReady(i) && focused.of(i))) {
    const why = whyNotClaimable(issue, ctx);
    if (why) {
      if (!providers(issue).length) skipped.push({ issue: issue.number, why });
      continue;
    }
    if (passed(issue)) {
      skipped.push({ issue: issue.number, why: PASSED });
      continue;
    }
    const blockers = await gh.blockers(issue);
    if (blockers.length) {
      skipped.push({ issue: issue.number, why: `blocked by ${blockers.join(', ')}` });
      continue;
    }
    if (await isSweeps(gh, issue)) {
      skipped.push({ issue: issue.number, why: 'its sub-issues are done: the sweep moves it to Review or Done' });
      continue;
    }
    candidates.push(issue);
  }
  for (const issue of await startOrder(gh, candidates, open)) {
    const job = await lock({ job: 'implement', issue: issue.number, title: issue.title, ...url(issue), ...partOf(issue, open), labels: labelNames(issue), lock: issue.number, focus: focused.of(issue) });
    if (job) return { ...job, ...await returnedFrom(gh, issue) }; // else lost the race: the next one
  }
  return { job: 'none', why: `nothing in focus is claimable${skip.size ? ' but what you passed over' : ''}`, skipped };
}

const PASSED = 'you passed over it';
/** Whether `skip` (as in next's opts) names a work item or a PR of this repository. */
const passedOver = (gh, skip) => (i) => refsOf(i).some((r) => skip.has(isKey(r) ? r : `${gh.repo}#${r}`));

/**
 * A pm tick's job (PROTOCOL.md, "PM ticks"), or an architect's
 * (ARCHITECT.md) when `kinds` is its own: the work item it holds already,
 * else one the owner labelled for it (`swarm/task-breakdown` or `swarm/design`
 * for a pm tick, `swarm/tech-design` for an architect), those
 * in focus first, then by priority, then the one more work waits on. It
 * builds nothing and reviews nothing.
 */
export async function nextBreakdown(gh, { me, doClaim = true, skip = new Set(), kinds = REQUEST_KINDS.pm }) {
  const passed = passedOver(gh, skip);
  const wanted = (i) => kinds.includes(requestKind(i));
  const open = (await gh.openIssues()).filter((i) => !handsOff(i));
  const job = (issue, extra) => ({ job: 'task-breakdown', kind: requestKind(issue), issue: issue.number, title: issue.title, ...url(issue), labels: labelNames(issue), lock: issue.number, ...extra });
  const mine = open.find((i) => wanted(i) && providers(i).includes(me) && !passed(i));
  if (mine) return job(mine, { resumed: true, claimed: true });
  const skipped = [];
  const candidates = [];
  for (const issue of open.filter(wanted)) {
    const why = whyNotBreakdown(issue) || (passed(issue) && PASSED);
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

// A blocker as `blockers` names it ('#21', 'ABC-9'), as an item's reference.
const blockerRef = (b) => (typeof b === 'string' && /^#\d+$/.test(b) ? Number(b.slice(1)) : b);

/**
 * What the owner put first: the open items in the current cycle (the sprint)
 * or labelled `swarm/focus`, and what those need: their children (the parent
 * link) and every open item one of them waits on, down the whole chain of
 * both, so a sprint item is never stuck behind work nobody will start.
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
  while (queue.length) {
    const item = queue.shift();
    for (const n of await gh.subIssues(item.number)) add(byRef.get(n), owner.get(item.number));
    for (const b of await gh.blockers(item)) add(byRef.get(blockerRef(b)), owner.get(item.number));
  }
  return { of: (issue) => refsOf(issue).map((r) => owner.get(r)).find((v) => v != null) ?? null };
}

/**
 * The order to start claimable work items in: priority, urgent first;
 * then the one more open work waits on, counted down the whole chain of
 * "Blocked by" lines and the tracker's blocking relations; then the oldest. A
 * part of an item being built counts what waits on that item, and is as old
 * as it: finishing comes before starting. Items equal on all keep the order
 * they came in.
 */
export async function startOrder(gh, candidates, open) {
  return (await rankCandidates(gh, candidates, open)).sort(byRank).map((r) => r.issue);
}

const byRank = (a, b) => a.priority - b.priority || b.unblocks - a.unblocks || a.since.localeCompare(b.since);

/** What startOrder orders by: [{ issue, priority: its rank, unblocks: how many open items wait on it, since: how old it counts as }], as given. */
export async function rankCandidates(gh, candidates, open) {
  const blocks = blockGraph(open);
  const waiting = async (i) => downstream(blocks, i.number, (await gh.blocking?.(i)) ?? []);
  return Promise.all(candidates.map(async (issue) => {
    const whole = splitFrom(issue, open);
    const unblocks = new Set([...await waiting(issue), ...(whole ? await waiting(whole) : [])]);
    return { issue, priority: priorityRank(issue), unblocks: unblocks.size, since: (whole ?? issue).created_at };
  }));
}

/**
 * Every item `me` could start now, or has just claimed, across the
 * repositories: [{ key, repo, priority, unblocks }], the one to start first
 * first. `next` orders within a repository; this is one order over all of
 * them, for the record of what a run chose from. A repository this token can't
 * read is left out.
 */
export async function queueOf(clients, { me, can = new Set() }) {
  const ranked = [];
  for (const gh of clients) {
    try {
      const issues = await gh.openIssues();
      const open = issues.filter((i) => !handsOff(i));
      const focused = await focusOf(gh, open);
      const ctx = { can, linked: linkedPulls(await gh.openPulls()), parents: openParents(issues) };
      // My own lock is no reason it couldn't be taken: it is on what this command claimed.
      const mineOff = (i) => ({ ...i, labels: i.labels.filter((l) => labelNames({ labels: [l] })[0] !== AGENT_PREFIX + me) });
      const candidates = [];
      for (const issue of open.filter((i) => isReady(i) && focused.of(i) && !whyNotClaimable(mineOff(i), ctx))) {
        if ((await gh.blockers(issue)).length || (!providers(issue).includes(me) && await isSweeps(gh, issue))) continue;
        candidates.push(issue);
      }
      ranked.push(...(await rankCandidates(gh, candidates, open)).map((r) => ({ ...r, repo: gh.repo })));
    } catch (e) {
      if (e.status !== 403 && e.status !== 404) throw e;
    }
  }
  return ranked.sort(byRank).map(({ issue, repo, unblocks }) => ({ key: issue.number, repo, priority: issue.priority ?? 'none', unblocks }));
}

const ORDER = ['fix', 'hold', 'merge', 'review', 'implement', 'task-breakdown'];
const url = (item) => (item.html_url ? { url: item.html_url } : {});

/** The sub-issues of an item that was split, once all are closed and one at least is not Canceled; else null. */
export async function finishedParts(gh, item) {
  const parts = await Promise.all((await gh.subIssues(item.number, 1)).map((k) => gh.findIssue(k)));
  return parts.every((p) => p.state !== 'open') && parts.some((p) => p.stage !== 'cancelled') ? parts : null;
}

/**
 * Whether an item's parts are done and the sweep has yet to move it on. One
 * with the owner's word on what failed came back from Review: an agent's again.
 */
const isSweeps = async (gh, item) => item.stage === 'started' && Boolean(await finishedParts(gh, item))
  && !(await returnedFrom(gh, item)).returned?.feedback.length;

/** For the job of a part of an item being built: which item, and what that changes. {} for any other. */
const partOf = (item, open) => {
  const whole = item && splitFrom(item, open);
  return whole ? { partOf: {
    issue: whole.number, title: whole.title, ...url(whole),
    how: `One part of ${whole.number} (agent.mjs show ${whole.number} lists the others and their states). Build only this part; its PR says "Closes ${item.number} (part of ${whole.number})". Never close ${whole.number} yourself: the sweep moves it on after its last part.`,
  } } : {};
};

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
const AGENT_MARKER = /<!-- agent(?:-heartbeat)?: /;

/**
 * Whether a work item came back from QA: a merged PR closes it, yet it is
 * open again, because the owner sent it back to Todo with a comment saying
 * which criterion failed (PROTOCOL.md, "Where the work is"). Then the job
 * carries `returned`: the PRs that shipped it, the people's comments since
 * the last of them merged, and how to go on, so the agent fixes what failed
 * rather than building the item again. {} for any other item. The merged PRs
 * are found among the item's links: the sweep links each PR it follows. An
 * item that was split was shipped by the PRs that closed its parts.
 */
export async function returnedFrom(gh, item) {
  if (!gh.links || !isKey(item.number)) return {};
  const numbers = [...new Set((await gh.links(item.number))
    .map((l) => PR_URL.exec(l.url ?? '')).filter((m) => m && m[1] === gh.repo).map((m) => Number(m[2])))];
  const refs = [...refsOf(item), ...await gh.subIssues(item.number)];
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
    ? `This came back from QA: ${shipped} shipped it, and the feedback says what failed. Fix only that, on a fresh branch from ${BASE_BRANCH}, in a new PR that says "Closes ${item.number}"; don't build again what already shipped.`
    : `This came back from QA after ${shipped} merged, but no comment since says what failed. Don't guess: ask with agent.mjs needs-human ${item.number} "<which criterion failed?>".`;
  return { returned: { pulls: merged, feedback, how } };
}

/**
 * `next` over several repositories: the job that
 * comes first in the tick's order, wherever it is, with its `repo`. clients:
 * one github.mjs client per repository, the home repository (where the desk
 * is) first. opts as for `next`, with `wrote` a Map of repo -> Set (`skip`'s
 * names say which repository). A
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
    then: `When this checkout is a clean ${BASE_BRANCH} at origin/${BASE_BRANCH} (or you have moved to a fresh worktree of it), run next again.`,
  };
}
