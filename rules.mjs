// The rules of the multi-provider agent protocol (see PROTOCOL.md), as pure
// functions over GitHub's REST shapes, so agent.mjs (an agent's tick) and
// sweep.mjs (the hourly check) decide the same way. No network here.

export const READY = 'couchy-ux/approved';
// The issue the nightly simulator run keeps open while flows fail on main
// (.github/workflows/ios-sim-nightly.yml): ready to take with no UX approval,
// by an agent with a simulator (it carries swarm/needs/ios-sim).
export const NIGHTLY = 'ios-sim/nightly';
export const STAGES = ['couchy-ux/needs-review', 'couchy-ux/needs-revision', 'couchy-ux/approved'];
export const SQUAD = 'lifecycle/claude-squad';
export const EPIC = 'kind/epic';
// Every label the agents' protocol owns is under `swarm/`, so a person reading
// an issue's labels can tell them from the product's and the squad's.
export const NS = 'swarm/';
export const NEEDS_HUMAN = `${NS}needs-human`;
export const HOLD = `${NS}hold`;
export const REVIEWED = 'reviewed';
export const FOCUS = `${NS}focus`;
export const CONFLICT = 'conflicts-with-main';
export const DESK = `${NS}desk`;
export const AGENT_PREFIX = `${NS}agent/`;
export const NEEDS_PREFIX = `${NS}needs/`;
export const SWARM_PR = `${NS}pr`;
export const HANDS_OFF = `${NS}hands-off`;
export const REVIEW_ONLY = `${NS}review-only`;

// The names these labels had before the namespace. They are still read
// everywhere (labelNames turns them into today's), so an issue an agent
// labelled from an old checkout or from memory is understood until the sweep
// renames it; nothing writes them any more.
const OLD_EXACT = { 'needs-human': NEEDS_HUMAN, 'merge/hold': HOLD, focus: FOCUS, 'agent-desk': DESK };
const OLD_PREFIX = [['agent/', AGENT_PREFIX], ['needs/', NEEDS_PREFIX]];

/** Today's name for a label, whichever name it was given under. */
export function canonical(name) {
  if (OLD_EXACT[name]) return OLD_EXACT[name];
  const hit = OLD_PREFIX.find(([old]) => name.startsWith(old));
  return hit ? hit[1] + name.slice(hit[0].length) : name;
}

/** The name a swarm label had before the namespace, or null. */
export function oldName(name) {
  const exact = Object.entries(OLD_EXACT).find(([, now]) => now === name);
  if (exact) return exact[0];
  const hit = OLD_PREFIX.find(([, now]) => name.startsWith(now));
  return hit ? hit[0] + name.slice(hit[1].length) : null;
}

const HOUR = 3_600_000;

export const labelNames = (item) => (item.labels ?? []).map((l) => canonical(typeof l === 'string' ? l : l.name));

/**
 * The agents working on an item right now, from its swarm/agent/<name>
 * labels, sorted. The label is a lock on work in progress, not ownership: an
 * agent puts it on when it starts a job and takes it off when its tick ends,
 * and whoever ticks next may carry the work on.
 */
export function providers(item) {
  // A set: an item can carry a claim under its old name and today's at once.
  return [...new Set(labelNames(item).filter((n) => n.startsWith(AGENT_PREFIX)).map((n) => n.slice(AGENT_PREFIX.length)))].sort();
}

/**
 * The owner's "leave this to me": `swarm/hands-off` on an issue or a PR takes
 * it out of the agents' hands altogether, for as long as the label is on. No
 * agent starts, fixes, continues, reviews or merges it, and nothing lapses.
 */
export const handsOff = (item) => labelNames(item).includes(HANDS_OFF);

/**
 * A PR its author keeps but wants the swarm to review: `swarm/review-only`.
 * Agents review it and give a verdict, and the `reviewed` gate holds it to
 * that verdict, but nobody fixes, continues or sets it to merge: its author
 * does. It wins over `swarm/pr` when a PR carries both, and `swarm/hands-off`
 * wins over it.
 */
export const isReviewOnly = (pr) => !handsOff(pr) && labelNames(pr).includes(REVIEW_ONLY);

/**
 * Whether a PR is the swarm's: it carries `swarm/pr`, which stays for the
 * PR's life, or an agent is on it now, and it isn't review-only. Everything
 * else is a person's PR: no agent fixes or merges it, and unless it is
 * review-only no agent reviews it and the `reviewed` gate lets it through.
 */
export const isSwarmPull = (pr) => !handsOff(pr) && !isReviewOnly(pr) && (labelNames(pr).includes(SWARM_PR) || providers(pr).length > 0);

/** Whether agents review a PR: the swarm's own, or a person's marked review-only. */
export const isReviewable = (pr) => isSwarmPull(pr) || isReviewOnly(pr);

/** Whether `me` may start work on an item: nobody else is on it now. */
export const freeFor = (item, me) => providers(item).every((p) => p === me);

/**
 * Who keeps an item two providers labelled at once. Adding a label is not
 * atomic, so both adds succeed; the alphabetically first provider keeps it and
 * the other removes its label. The rule needs no timestamps, so an agent with
 * nothing but "read the labels" can follow it by hand.
 */
export const claimWinner = (item) => providers(item)[0] ?? null;

export const isValidProvider = (p) => /^[a-z0-9][a-z0-9-]*$/.test(p ?? '');

/** Issue numbers a PR body says it closes ("Closes #12", "fixes #3, resolves #4"). */
export function closingIssues(body) {
  const out = new Set();
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+((?:#\d+(?:\s*(?:,|and)\s*)?)+)/gi;
  for (const m of (body ?? '').matchAll(re)) {
    for (const n of m[1].matchAll(/#(\d+)/g)) out.add(Number(n[1]));
  }
  return [...out];
}

/**
 * The issues an issue's body says block it. Couchy's sub-issues name their
 * blockers in prose ("Blocked by: #640, #641", "Part of #901. Blocked by #902.
 * Blocks #906.", "Blocked by getcouchy/couchy-agent#5"), not in GitHub's
 * dependency links, so this is where the order of work is written down.
 * Returns [{ repo: 'owner/name' or null for this repo, number }].
 */
export function bodyBlockers(body) {
  const out = new Map();
  for (const m of (body ?? '').matchAll(/blocked by:?([^\n]*)/gi)) {
    // The sentence ends at a full stop or at "Blocks", which lists the other direction.
    const sentence = m[1].split(/\.(?:\s|$)|\bblocks\b/i)[0];
    for (const ref of sentence.matchAll(/(?:([\w.-]+\/[\w.-]+))?#(\d+)/g)) {
      out.set(`${ref[1] ?? ''}#${ref[2]}`, { repo: ref[1] ?? null, number: Number(ref[2]) });
    }
  }
  return [...out.values()];
}

const mentions = (body) => [...(body ?? '').matchAll(/(?<![\w/-])#(\d+)/g)].map((m) => Number(m[1]));

/**
 * What the owner's `swarm/focus` label puts at the front of the queue. The label
 * goes on one issue, or on an epic or sequence issue. An issue is in focus
 * when it carries the label, when its body mentions a focused issue ("Part of
 * #1412", "Sequence: #1412 wave 2"), when a focused issue's body names it, or
 * when it is a sub-issue of a focused issue.
 * focusedIssues: the open issues labelled `swarm/focus`.
 * subIssues: focused issue number -> its sub-issues' numbers, in GitHub's order.
 * Returns { of(issue): the focused issue's number or null,
 *           order(issues): those in focus first, then the rest as they were }.
 * Issues that carry the label themselves come first: with the label on an
 * epic and on some of its children, those children are the owner's pick within
 * the epic. Then the rest in focus. Within each group, issues a focused issue
 * lists come in the order it lists them, since a sequence issue is written in
 * the order the work should happen; then its sub-issues the body leaves out,
 * in GitHub's order; the others follow in the order given.
 */
export function focus(focusedIssues, subIssues = new Map()) {
  const numbers = new Set(focusedIssues.map((i) => i.number));
  const listed = new Map(); // issue number -> { by, at }: who lists it and how early
  for (const f of focusedIssues) {
    [...mentions(f.body), ...(subIssues.get(f.number) ?? [])].forEach((n, at) => {
      if (!listed.has(n) && n !== f.number) listed.set(n, { by: f.number, at });
    });
  }
  const of = (issue) => {
    if (numbers.has(issue.number)) return issue.number;
    if (listed.has(issue.number)) return listed.get(issue.number).by;
    return mentions(issue.body).find((n) => numbers.has(n)) ?? null;
  };
  const order = (issues) => {
    const at = (i) => listed.get(i.number)?.at ?? Infinity;
    const tier = (i) => (numbers.has(i.number) ? 0 : 1);
    const inFocus = issues.filter((i) => of(i)).map((i, k) => ({ i, k }))
      .sort((a, b) => tier(a.i) - tier(b.i) || at(a.i) - at(b.i) || a.k - b.k).map((x) => x.i);
    return [...inFocus, ...issues.filter((i) => !of(i))];
  };
  return { of, order };
}

/** Issue numbers a PR body says it is part of ("Part of #641", "part of #763 (part 2 of 3)"). */
export function partOfIssues(body) {
  return [...(body ?? '').matchAll(/\bpart of #(\d+)/gi)].map((m) => Number(m[1]));
}

/**
 * issue number -> open PRs for it: those whose body closes it, or says it is
 * part of it (a large issue lands as several "Part of #N" PRs). While one is
 * open the issue is in progress there, and is not offered as new work.
 */
export function linkedPulls(pulls) {
  const map = new Map();
  for (const pr of pulls) {
    for (const n of new Set([...closingIssues(pr.body), ...partOfIssues(pr.body)])) map.set(n, [...(map.get(n) ?? []), pr]);
  }
  return map;
}

const withPrefix = (item, prefix) => labelNames(item).filter((n) => n.startsWith(prefix));

/**
 * Why `me` may not claim this issue, or null when it may.
 * ctx: { can: Set of swarm/needs/* suffixes this agent's sandbox has,
 *        linked: Map from linkedPulls() }
 * Two agents may hold issues in the same `area/*` at once: the label says
 * what part of the product an issue is in, not that its work must queue. A
 * PR that falls behind main gets `conflicts-with-main` and its author fixes it.
 */
export function whyNotClaimable(issue, ctx) {
  const names = labelNames(issue);
  if (issue.pull_request) return 'a pull request';
  if (issue.state && issue.state !== 'open') return 'closed';
  if (!names.includes(READY) && !names.includes(NIGHTLY)) return `not ${READY}`;
  if (names.includes(EPIC)) return 'an epic';
  if (names.includes(NEEDS_HUMAN)) return `${NEEDS_HUMAN}`;
  if (names.includes(HANDS_OFF)) return `${HANDS_OFF}`;
  if (providers(issue).length) return `held by ${providers(issue).join(', ')}`;
  if (ctx.linked?.get(issue.number)?.length) return `PR #${ctx.linked.get(issue.number)[0].number} is already open for it`;
  const missing = withPrefix(issue, NEEDS_PREFIX).map((n) => n.slice(NEEDS_PREFIX.length)).filter((n) => !ctx.can?.has(n));
  if (missing.length) return `needs ${missing.join(', ')}`;
  return null;
}

/** An agent's own bot login, `couchy-codex[bot]` (see bots.mjs), → `codex`. */
export function agentFromLogin(login) {
  return /^couchy-([a-z0-9-]+)\[bot\]$/.exec(login ?? '')?.[1] ?? null;
}

// `<!-- agent: codex -->`, or with the review's verdict: `<!-- agent: codex verdict: ok -->`.
const MARKER = /<!--\s*agent:\s*([a-z0-9-]+)(?:\s+verdict:\s*(ok|changes))?\s*-->/;

/**
 * What a review concluded: 'ok' (merge it), 'changes' (the author's turn), or
 * null for one that only comments. Agents that share the author's GitHub
 * account can't approve or request changes there, so the marker carries the
 * verdict; a real approval or change request from another account counts too.
 */
export function reviewVerdict(review) {
  const marked = MARKER.exec(review.body ?? '')?.[2];
  if (marked) return marked;
  if (review.state === 'APPROVED') return 'ok';
  if (review.state === 'CHANGES_REQUESTED') return 'changes';
  return null;
}

/** The latest review with a verdict, among those that count, or null. */
export function lastVerdict(pr, reviews) {
  const r = independentReviews(pr, reviews)
    .filter((x) => reviewVerdict(x))
    .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))
    .at(-1);
  return r ? { verdict: reviewVerdict(r), at: r.submitted_at } : null;
}

/**
 * Whether a PR is waiting for a reviewer: nobody independent has reviewed it,
 * or the last verdict was 'changes' and the author has pushed since.
 */
export function needsReview(pr, reviews, pushedAt) {
  if (!independentReviews(pr, reviews).length) return true;
  const last = lastVerdict(pr, reviews);
  return last?.verdict === 'changes' && Boolean(pushedAt) && pushedAt > last.at;
}

/**
 * The `reviewed` commit status for a PR's head (see reviewed.mjs): GitHub's
 * own record of the review gate. Once it is a required check on main, a PR
 * can't merge without an `ok` verdict or while a hold label is on it, however
 * early auto-merge was turned on. A PR with no agent label is a person's and
 * passes, unless it carries `swarm/review-only`: the gate is for the agents'
 * work and for what a person asked the agents to review.
 */
export function reviewedStatus(pr, reviews = []) {
  const names = labelNames(pr);
  if (handsOff(pr)) return { state: 'success', description: `${HANDS_OFF}: the owner has this one` };
  if (!isReviewable(pr)) return { state: 'success', description: 'Not an agent\'s pull request' };
  if (names.includes(NEEDS_HUMAN)) return { state: 'pending', description: `Held: ${NEEDS_HUMAN}` };
  if (names.includes(HOLD)) return { state: 'pending', description: `Held: ${HOLD}` };
  const last = lastVerdict(pr, reviews)?.verdict;
  if (last === 'ok') return { state: 'success', description: 'Reviewed ok' };
  if (last === 'changes') return { state: 'failure', description: 'The latest review asks for changes' };
  return { state: 'pending', description: 'Waiting for a review verdict' };
}

/**
 * Why an open PR should not have auto-merge on, or null when it should.
 * Auto-merge is the default, and this list is every reason to leave it off
 * (PROTOCOL.md, "Merging"). `held: true` marks the reasons that also take
 * auto-merge off a PR that already has it; the others (a red check, a
 * conflict) GitHub waits out itself.
 *
 * `gated`: `reviewed` is a required check on main. GitHub then enforces the
 * verdict and the hold labels itself, so auto-merge goes on when the PR opens
 * and nothing but being a draft keeps it off.
 */
export function whyNotMerge(pr, { reviews = [], checks = [], gated = false } = {}) {
  const names = labelNames(pr);
  if (isReviewOnly(pr)) return { why: `\`${REVIEW_ONLY}\`: its author merges it`, held: false };
  if (pr.draft) return { why: 'a draft', held: true };
  if (gated) return null;
  if (names.includes(NEEDS_HUMAN)) return { why: `\`${NEEDS_HUMAN}\`: waits on a person`, held: true };
  if (names.includes(HOLD)) return { why: `\`${HOLD}\`: its author is holding it`, held: true };
  const last = lastVerdict(pr, reviews)?.verdict;
  if (last === 'changes') return { why: 'its latest review asks for changes', held: true };
  if (!last) return { why: 'not reviewed yet', held: false };
  if (names.includes(CONFLICT)) return { why: 'conflicts with main', held: false };
  if (checks.some((c) => FAILED.has(c.conclusion))) return { why: 'a failed check', held: false };
  return null;
}

/** Whether a PR should have auto-merge turned on now. */
export const mergeReady = (pr, ctx) => !whyNotMerge(pr, ctx);

/** Why a PR with auto-merge on should have it turned off, or null. */
export function mergeHeld(pr, ctx) {
  const not = pr.auto_merge ? whyNotMerge(pr, ctx) : null;
  return not?.held ? not.why : null;
}

/** The agent a review speaks for, from its `<!-- agent: codex -->` marker. */
export function reviewProvider(review) {
  return MARKER.exec(review.body ?? '')?.[1] ?? null;
}

/**
 * Reviews that count as a second pair of eyes on a PR: an agent's marked
 * review, or one from another account. An agent's review counts whatever its
 * name, the author's included: a review is written by a session that starts
 * fresh, not by the one that wrote the code. Agents may share one GitHub
 * account (or one bot, when sessions share a name), so an unmarked review
 * (the author replying in a thread, say) counts only when it comes from
 * another account. An agent's own bot (`couchy-<name>[bot]`) is an account
 * like a person's; any other bot (a review bot such as cubic) never counts.
 */
export function independentReviews(pr, reviews) {
  return reviews.filter((r) => {
    if (r.state === 'PENDING' || r.state === 'DISMISSED') return false;
    if (r.user?.type === 'Bot' && !agentFromLogin(r.user.login)) return false;
    return reviewProvider(r) ? true : r.user?.login !== pr.user?.login;
  });
}

export const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

/**
 * Why a PR is its author's turn again: conflicts, a failed check, or changes
 * requested since the last push. checks: check runs of the head commit;
 * pushedAt: ISO time of the head commit.
 */
export function fixReasons(pr, { checks = [], reviews = [], pushedAt = null } = {}) {
  const reasons = [];
  if (labelNames(pr).includes(CONFLICT)) reasons.push('conflicts with main');
  const failed = checks.filter((c) => FAILED.has(c.conclusion)).map((c) => c.name);
  if (failed.length) reasons.push(`failed checks: ${[...new Set(failed)].join(', ')}`);
  const last = lastVerdict(pr, reviews);
  if (last?.verdict === 'changes' && (!pushedAt || last.at > pushedAt)) reasons.push('changes requested');
  return reasons;
}

export const hoursSince = (iso, now) => (now - Date.parse(iso)) / HOUR;

/**
 * A lock lapses when it has been on for longer than a tick can last: its
 * agent crashed, ran out of quota or forgot to take it off. lockedAt: when
 * the label was last put on.
 */
export function lockLapsed({ lockedAt, now, minutes }) {
  return !lockedAt || (now - Date.parse(lockedAt)) / 60_000 > minutes;
}

export function heartbeatMarker(id) {
  return `<!-- agent-heartbeat: ${id} -->`;
}

export function heartbeatId(comment) {
  return /<!--\s*agent-heartbeat:\s*([\w./-]+)\s*-->/.exec(comment.body ?? '')?.[1] ?? null;
}
