// The rules of the multi-provider agent protocol (see PROTOCOL.md), as pure
// functions over the shapes the clients return: GitHub's REST shapes for pull
// requests, and Plane work items shaped like issues (plane.mjs), so agent.mjs
// (an agent's tick) and sweep.mjs (the regular check) decide the same way. No
// network here.

// A work item is ready to take in Plane's Todo or In Progress, the `unstarted`
// and `started` state groups. In Progress with nobody on it and no PR open is
// work an agent let go of; Backlog is not ready yet.
export const READY_STAGES = ['unstarted', 'started'];
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
export const QA = `${NS}qa`;
export const BLOCKED = `${NS}blocked`;
export const CONFLICT = 'conflicts-with-main';
export const DESK = `${NS}desk`;
export const AGENT_PREFIX = `${NS}agent/`;
export const NEEDS_PREFIX = `${NS}needs/`;
export const SWARM_PR = `${NS}pr`;
export const HANDS_OFF = `${NS}hands-off`;
export const REVIEW_ONLY = `${NS}review-only`;

/** Whether a work item is in a state an agent may take it from. */
export const isReady = (item) => READY_STAGES.includes(item.stage);

/** How a line names an item: `COUCHYUX-12` for a work item, `#57` for a pull request. */
export const refText = (ref) => (typeof ref === 'number' ? `#${ref}` : String(ref));

/** Every reference that names an item: its own, and the GitHub issue a work item was copied from. */
export const refsOf = (item) => [item.number, ...(item.aliases ?? [])];

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

// A work item's key (`COUCHYUX-12`) or a GitHub number (`#1680`), as a pull
// request or a description writes it. Numbers are what PRs opened before the
// work moved to Plane, and descriptions copied from GitHub, still say.
const KEY_RE = String.raw`[A-Z][A-Z0-9]*-\d+`;
const refsIn = (text) => [...(text ?? '').matchAll(new RegExp(String.raw`#(\d+)|\b(${KEY_RE})\b`, 'g'))].map((m) => (m[1] ? Number(m[1]) : m[2]));

/** What a PR body says it closes ("Closes COUCHYUX-12", "fixes #3, resolves #4"): keys, and numbers for `#n`. */
export function closingIssues(body) {
  const out = new Set();
  const re = new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+((?:(?:#\d+|${KEY_RE})(?:\s*(?:,|and)\s*)?)+)`, 'gi');
  for (const m of (body ?? '').matchAll(re)) for (const ref of refsIn(m[1])) out.add(ref);
  return [...out];
}

/**
 * The items a description says block it, in prose ("Blocked by: COUCHYUX-40,
 * #641", "Part of #901. Blocked by #902. Blocks #906.", "Blocked by
 * getcouchy/couchy-agent#5"). Returns [{ key }] for work items and
 * [{ repo: 'owner/name' or null for this repo, number }] for GitHub issues.
 */
export function bodyBlockers(body) {
  const out = new Map();
  for (const m of (body ?? '').matchAll(/blocked by:?([^\n]*)/gi)) {
    // The sentence ends at a full stop or at "Blocks", which lists the other direction.
    const sentence = m[1].split(/\.(?:\s|$)|\bblocks\b/i)[0];
    for (const ref of sentence.matchAll(new RegExp(String.raw`(?:([\w.-]+\/[\w.-]+))?#(\d+)|\b(${KEY_RE})\b`, 'g'))) {
      if (ref[3]) out.set(ref[3], { key: ref[3] });
      else out.set(`${ref[1] ?? ''}#${ref[2]}`, { repo: ref[1] ?? null, number: Number(ref[2]) });
    }
  }
  return [...out.values()];
}

// Labels that say a work item changes what people see and use, and those that
// say it doesn't. needsQA reads them.
const UI_LABELS = ['platform/web', 'platform/ios', 'area/app', 'web/ux-buildout'];
const BACKEND_LABELS = ['area/api', 'area/tooling', 'area/ci'];

/**
 * Whether a work item goes to QA, for the owner to walk its acceptance
 * criteria, once the PR that closes it merges, rather than straight to Done:
 * it carries `swarm/qa`, a label that says it touches what people use, or no
 * label that says it is backend work only. An agent may add `swarm/qa`; nothing
 * takes an item out of QA but the owner.
 */
export function needsQA(item) {
  const names = labelNames(item);
  return names.includes(QA) || names.some((n) => UI_LABELS.includes(n)) || !names.some((n) => BACKEND_LABELS.includes(n));
}

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
/** Plane's priority as a rank, urgent first; an item without one ranks with `none`. */
export const priorityRank = (item) => PRIORITY_RANK[item.priority] ?? PRIORITY_RANK.none;

/**
 * Which open items each open item blocks, from the "Blocked by" lines of
 * their descriptions: Map from an item's number to the Set of numbers waiting
 * on it. Read from the bodies already in hand, so it costs no request; Plane's
 * relations are added per item by the caller (`downstream`'s `extra`).
 */
export function blockGraph(issues) {
  const byRef = new Map(issues.flatMap((i) => refsOf(i).map((r) => [r, i])));
  const resolve = (b) => byRef.get(b.key ?? (b.repo ? `${b.repo}#${b.number}` : b.number));
  const blocks = new Map();
  for (const issue of issues) {
    for (const ref of bodyBlockers(issue.body)) {
      const blocker = resolve(ref);
      if (!blocker || blocker.number === issue.number) continue;
      if (!blocks.has(blocker.number)) blocks.set(blocker.number, new Set());
      blocks.get(blocker.number).add(issue.number);
    }
  }
  return blocks;
}

/** Every item waiting on `number`, directly or further down the chain, as a Set; `extra` adds direct ones. */
export function downstream(blocks, number, extra = []) {
  const seen = new Set();
  const todo = [...(blocks.get(number) ?? []), ...extra];
  while (todo.length) {
    const n = todo.pop();
    if (seen.has(n) || n === number) continue;
    seen.add(n);
    todo.push(...(blocks.get(n) ?? []));
  }
  return seen;
}

/** What a PR body says it is part of ("Part of COUCHYUX-12", "part of #763 (part 2 of 3)"). */
export function partOfIssues(body) {
  return [...(body ?? '').matchAll(new RegExp(String.raw`\bpart of (#\d+|${KEY_RE})`, 'gi'))].map((m) => refsIn(m[1])[0]).filter((r) => r != null);
}

/**
 * reference -> open PRs for it: those whose body closes it, or says it is
 * part of it (a large item lands as several "Part of" PRs). While one is open
 * the item is in progress there, and is not offered as new work.
 */
export function linkedPulls(pulls) {
  const map = new Map();
  for (const pr of pulls) {
    for (const n of new Set([...closingIssues(pr.body), ...partOfIssues(pr.body)])) map.set(n, [...(map.get(n) ?? []), pr]);
  }
  return map;
}

/** The open PRs for an item, under any reference to it. */
export const linkedTo = (linked, issue) => [...new Set(refsOf(issue).flatMap((r) => linked?.get(r) ?? []))];

const withPrefix = (item, prefix) => labelNames(item).filter((n) => n.startsWith(prefix));

/**
 * Why `me` may not claim this work item, or null when it may.
 * ctx: { can: Set of swarm/needs/* suffixes this agent's sandbox has,
 *        linked: Map from linkedPulls() }
 * Two agents may hold items with the same `area/*` label at once: the label
 * says what part of the product an item is in, not that its work must queue.
 * A PR that falls behind main gets `conflicts-with-main` and its author fixes it.
 */
export function whyNotClaimable(issue, ctx) {
  const names = labelNames(issue);
  if (issue.pull_request) return 'a pull request';
  if (issue.state && issue.state !== 'open') return 'closed';
  if (names.includes(DESK)) return 'the Agent desk';
  if (!isReady(issue)) return `not ready: in ${issue.stage ?? 'no'} state, not Todo or In Progress`;
  if (names.includes(EPIC)) return 'an epic';
  if (names.includes(NEEDS_HUMAN)) return `${NEEDS_HUMAN}`;
  if (names.includes(HANDS_OFF)) return `${HANDS_OFF}`;
  if (providers(issue).length) return `held by ${providers(issue).join(', ')}`;
  const open = linkedTo(ctx.linked, issue);
  if (open.length) return `PR #${open[0].number} is already open for it`;
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

/**
 * The one state a pull request is in, for the metrics (docs/metrics.md): the
 * first of these that holds. A held PR reads `needs_human` or `hold` whatever
 * else is true of it, since nothing else moves until the label comes off.
 */
export function pullState(pr, { reviews = [], checks = [], pushedAt = null, gated = false } = {}) {
  const names = labelNames(pr);
  if (pr.draft) return 'draft';
  if (names.includes(NEEDS_HUMAN)) return 'needs_human';
  if (names.includes(HOLD)) return 'hold';
  if (fixReasons(pr, { checks, reviews, pushedAt }).length) return 'needs_work';
  if (needsReview(pr, reviews, pushedAt)) return 'needs_review';
  if (pr.auto_merge) return 'merging';
  if (mergeReady(pr, { reviews, checks, gated })) return 'merge_ready';
  return 'waiting';
}

/** The agent an item is with: whoever holds its lock, else the agent whose bot opened it, else ''. */
export const agentOf = (item) => providers(item)[0] ?? agentFromLogin(item.user?.login) ?? '';

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
