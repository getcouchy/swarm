# The agent protocol

Several coding agents (Claude, Codex, Grok…, sometimes more than one of each)
work in the getcouchy repositories at once. They can't message each other, so
Linear and GitHub are the only shared state: the work is in Linear, the pull
requests are on GitHub, labels on both say whose turn it is, and this file is
the protocol every agent follows, whatever its provider.

Each repository that uses it has an `AGENTS.md` that points here and adds what
is its own: its code conventions, its rules for pull requests, and any work it
puts ahead of the queue. Those apply to every agent, not only the one whose
provider reads that file by name, and where they say more than this file they
win for that repository.

## Where the work is

**Work items are in Linear** (https://linear.app/couchy, workspace `couchy`).
The work for getcouchy/couchy, getcouchy/couchy-agent and
getcouchy/agent-runner is in one team, **Couchy** (`COU`). A work item is a
Linear issue, named by its key, `COU-12`. It belongs to getcouchy/couchy
unless a label in the `repo` group (`repo/couchy-agent`, `repo/agent-runner`)
names another. Projects are the epics; the team's current cycle is the sprint.

The work moved here from Plane. An old Plane key (`COUCHYUX-12`, `RUNNER-3`)
or the number of the GitHub issue an item was copied from still reaches the
item (`moved.json` maps each to its `COU` key), so a PR or description that
names one needs no change. Write `COU` keys from now on.

**Pull requests stay on GitHub**, and so do their reviews, checks and labels.
GitHub's issues are not the swarm's any more: don't read the queue there,
don't open issues there, and don't close or edit the ones that are left.
Every open one was copied into Linear, and a work item copied from one
carries a link back to it.

The tools read `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` (README.md has
the others). An agent without the tools uses Linear's GraphQL API
(`https://api.linear.app/graphql`, header `Authorization: Bearer <token>`, or
the bare key for a personal one) or the Linear MCP server. A sandbox that
can't reach Linear can review and fix pull requests, but takes no work item.

What a work item's state means here:

| State | Means |
| --- | --- |
| Backlog | not ready: being shaped, or waiting on the owner's approval |
| Todo | ready for an agent to take |
| In Progress, In Review | an agent has it, or a pull request for it is open; with neither, it is ready again |
| Needs Human | waiting on a person: an agent asked a question only they can answer, or needs a step only they can take (see "When to call a person"); no agent takes it |
| QA | a pull request that closes it merged, and the owner is walking its acceptance criteria; no agent takes it, and it blocks nothing |
| Done | a pull request that closes it merged, and it needed no QA or passed it |
| Canceled | not doing it |

The owner moves work from Backlog to Todo; that is the approval. The tools
move it to In Progress when an agent claims it, and the sweep moves it from
Todo to In Progress while a pull request for it is open. Nothing moves work
out of Backlog but the owner, even with a pull request open for it. When one that closes it merges, the sweep
moves it to QA if it changes what people see and use, and to Done if not:
QA when it carries `swarm/qa`, `platform/web`, `platform/ios` or `area/app`,
or none of `area/api`, `area/tooling` and `area/ci`. Add
`swarm/qa` to backend work whose result people will notice; nothing takes
work out of QA but the owner, who moves it to Done when it passes, or back to
Todo with a comment saying which criterion failed. Nothing takes work out of
Needs Human but the owner either, who moves it on (to Backlog or Todo) once
they have answered. Don't move a work item to QA or Done yourself, or to Needs
Human but with `needs-human`.

An item back in Todo from QA is not new work: what shipped stays, and you fix
only what the owner's comment says failed, on a fresh branch, in a new PR that
says `Closes <key>`. `next` tells you when an item came back (the job's
`returned`: the merged PRs and the comments since); with no comment saying
what failed, ask with `needs-human` rather than guess.

**Labels in Linear are in groups.** The swarm's are in two: `swarm-agent`,
whose labels are the locks (`claude-1`, `codex-1`), and `swarm`
(`needs-shaping`, `needs-ios-sim`, `blocked`, …). The product's are in `repo`,
`area`, `platform` and `kind`. This file names a label by its group and name,
as Linear's filters do: `repo/agent-runner`, `area/app`, `swarm/needs-shaping`.
A lock is the exception: `claude-1` in `swarm-agent` is what GitHub calls
`swarm/agent/claude-1`, and this file calls it that. Every group but `swarm`
takes **one label per work item**: Linear refuses a second, so an item has one
repository, one area, one platform and one lock. To change one, take the old
label off first (`agent.mjs labels COU-12 -area/app +area/api`). The tools make
a label they need in its group the first time it is used.

## Your name

The prompt that wakes you names you: "run your tick as `claude-2`". That name
is who you are here, and `swarm/agent/<your name>` (`swarm/agent/claude-2`) is
your label: on GitHub under that name, in Linear as `claude-2` in the
`swarm-agent` group.
A name is lower-case letters, digits and hyphens, and whoever sets up the agent
chooses it: `codex`, `grok`, `claude-2`, `claude-1-scheduled`.

- **Only the exact label is yours.** If you are `claude-2`, then `swarm/agent/claude`
  is another agent's label, even though you are both Claude: what it is on
  right now, you leave alone.
- Use the name you were given even where another file (`CLAUDE.md`) names a
  default label. `swarm/agent/claude` is the name of the Claude project agents, and
  the default only for a Claude session whose prompt gives it no name.
- If nothing names you, don't guess: do no claiming, and say so.
- **Your GitHub account.** A name can have a GitHub App of its own,
  `couchy-<name>[bot]` (see [`README.md`](README.md)).
  If your sandbox has the `COUCHY_BOT_*` variables, run
  `eval "$(node ../swarm/bots.mjs env)"` at the start of each tick and
  `node ../swarm/bots.mjs git-setup` once per clone, so you push, comment
  and commit as your bot. Keep the review marker either way.

## The one rule

**A `swarm/agent/<name>` label means that agent is working on this right
now.** It is a lock, not ownership. Put yours on a work item or a pull request
before you change anything for it, and take it off when your tick ends. While
another agent's label is on something, don't touch it: no commits, no review,
no new work for that item. Never remove another agent's label.

Once the label is off, the work is anyone's. Nothing here belongs to the
agent that started it: every session begins from the same work item, pull
request and code, whatever its name, so whoever ticks next carries on where
the last one stopped. That is why a tick must end with everything pushed and the PR
saying what is done and what is left (see "When a tick ends").

In Linear a work item takes one lock: adding yours while another agent's is on
is refused, and the claim is lost (`claim` says so). On GitHub two can land at
once; the tie-break is under "By hand".

**`swarm/hands-off` is the owner's.** On a work item or a pull request it means
the owner is doing this one: leave it entirely alone, however stale or red it
looks, until the label comes off. Only the owner adds or removes it.

A pull request the agents opened carries `swarm/pr` for its whole life. That
label, not the lock, is what makes it the swarm's to review, fix and merge.
Put it on every PR you open.

A person who wants the agents' review on their own PR, and nothing more, puts
`swarm/review-only` on it. Review it like any other (step 3), and the
`reviewed` check holds it to your verdict, but it stays its author's: never
push to it, fix it, continue it, or turn its auto-merge on or off. It wins
over `swarm/pr` when a PR carries both.

## The labels

Every label this protocol owns starts with `swarm/` on GitHub, and is in the
`swarm` or `swarm-agent` group in Linear. Anything else on a work item or a PR
(`repo/*`, `area/*`, `platform/*`, `kind/*`, `conflicts-with-main`,
`changelog/none`) belongs to the product or CI.

| Label | Means | Who sets it |
| --- | --- | --- |
| `swarm/agent/<name>` | that agent is working on this work item or PR right now | the agent, for the length of its tick |
| `swarm/pr` | a PR the agents opened: theirs to review, fix and merge | the agent that opens it |
| `swarm/review-only` | a person's PR the agents review, and the `reviewed` check gates, but never fix, continue or merge | the PR's author or the owner |
| `swarm/focus` | a work item to take first, beside the sprint (see "Focus") | the owner only |
| `swarm/needs-shaping` | make this work item ready to build: scope, acceptance criteria, labels, blockers, slices (see "Shaping ticks"); no tick builds it meanwhile | the owner only |
| `swarm/design` | groom it, and design it in getcouchy/couchy-design: spec and wireframes (see "Shaping ticks"); no tick builds it meanwhile | the owner only |
| `swarm/shaped` | a shaping tick has done what `swarm/needs-shaping` or `swarm/design` asked; the owner reviews it | a shaping tick, in place of the request |
| `swarm/qa` | when its closing PR merges, the work item goes to QA, not Done (see "Where the work is") | an agent or the owner; only the owner removes it |
| `swarm/blocked` | the work item waits on other work: an open blocker, for views to filter on; ask for the blockers yourself before taking work. Not the Needs Human state, which waits on a person | the sweep only; it takes off any it finds without an open blocker |
| `swarm/needs-human` | on a PR: a real fork or a step only a person can take; pages the owner and holds the merge. A work item goes to the Needs Human state instead | an agent, after its comment |
| `swarm/hold` | holds a PR's merge for a wait an agent can end; pages nobody | an agent, with a comment |
| `swarm/hands-off` | the owner is handling this work item or PR: no agent starts, fixes, continues, reviews or merges it | the owner only |
| `swarm/needs-<thing>` | the work can't be checked without `<thing>` (see "What you may take"); the tools call it `swarm/needs/<thing>` | whoever writes the work item |
| `swarm/desk` | marks the Agent desk work item | the sweep |

Until 2026-11-12 these were `agent/<name>`, `focus`, `needs-human`,
`merge/hold`, `needs/<thing>` and `agent-desk`, and until 2026-11-20
`swarm/needs-shaping` was `swarm/groom`. The tools still read the old names,
and the sweep renames any it finds, but write only the new ones. The sweep
also moves a work item still labelled `swarm/needs-human` to Needs Human.

## The repositories

The swarm works in **getcouchy/couchy** (the app and its API) and
**getcouchy/couchy-agent** (the agent that runs beside ComfyUI). The same
labels mean the same things in both, and both repositories' work is in
COU. A work item for one is often blocked by one for the other: Linear's
"blocked by" relation says so, or its description ("Blocked by COU-40").

A tick covers the repositories its scheduler gives it: the ones its prompt
names, which with a token are `AGENT_REPOS` (default: the repository you work
in, then getcouchy/couchy-agent). The first is its **home repository**: its
open `swarm/desk` work item belonging to it is the Agent desk your heartbeat
goes on. Go through the steps below across all of them, taking the first step
that applies anywhere before a later step somewhere else. A PR goes to the
repository its work item belongs to, and follows that repository's own
`AGENTS.md` for the rest.

A tick can reach only the repositories its sandbox was given. One it can't read
it passes by. Today getcouchy/couchy's ticks have it as their home.

## Your tick

Your scheduler wakes you with "run your tick as `<your name>`". Note the time
you start. A scheduled task whose prompt points you to
[`TICK.md`](TICK.md) sets up its session as that file says.

**First, get current.** The protocol and its tools change often, and a
checkout left from yesterday follows yesterday's rules. Clone
getcouchy/swarm beside the checkout you work in at the start of every tick
(`git clone --depth 1 https://github.com/getcouchy/swarm ../swarm`; it is
public, so no access is needed), or `git -C ../swarm pull --ff-only` a clone
you keep, and read this file from there and your repository's `AGENTS.md`
from a fresh checkout of its `main`. If
you work in a checkout that outlives the tick:

- On `main` with nothing uncommitted (untracked files don't count):
  `git fetch origin`, then `git merge --ff-only origin/main`, before you set up your bot and before you
  read its `AGENTS.md` for the tick. `agent.mjs next` does this itself, and
  every `agent.mjs` command runs `origin/main`'s copy of the tools even from an
  old clone of getcouchy/swarm. A detached checkout of `origin/main` (a fresh
  worktree) counts the same; move it with `git checkout --detach origin/main`.
- On another branch, with uncommitted changes, or on a `main` with commits
  `origin/main` lacks: don't pull over it, and take no new work yet (`next`
  hands you the checkout itself as the job and claims nothing). Find out
  what it is first. It is most likely unfinished work: the branch of an open
  PR, or the start of a work item with no PR yet (`next` names the likeliest).
  If it is the swarm's and no other agent's label is on it, lock it, push what
  is finished (a draft PR that says what is left), then start the tick from a
  clean `main`. If another agent is on it now, or it is a person's PR, touch
  nothing. If nothing explains it, don't discard it. In both of those cases
  say so in your heartbeat and run the tick from a fresh worktree of
  `origin/main`.

Then do the first of these that applies; when it is done, come back to
the top and do the next, until the tick ends (see "When a tick ends"):

1. **Fix a pull request that needs it.** An open, non-draft `swarm/pr` PR
   that no other agent is on, with a failed check, the `conflicts-with-main`
   label, or a review whose verdict is `changes` since its last push. It
   doesn't matter who opened it. Lock it, check out its branch, fix it, push.
   A held PR is not one: with `swarm/needs-human` leave it until the person
   answers, and with `swarm/hold` a failed check or a conflict waits for what
   the PR is held for. Only a `changes` verdict on a `swarm/hold` PR is work.
2. **Keep auto-merge right.** It is the default for every `swarm/pr` PR (see
   "Merging"). Where `reviewed` is a required check, any non-draft one with
   auto-merge off: turn it on. Where it isn't, turn it on for one whose latest
   review verdict is `ok` with nothing from the exceptions list holding it,
   and turn it off for one that is now held (`swarm/needs-human`, `swarm/hold`, a
   later `changes` verdict).
3. **Review a pull request.** An open, non-draft `swarm/pr` or
   `swarm/review-only` PR that nobody is working on right now and that nobody has reviewed, or that has been pushed
   to since a `changes` verdict. Review it against its work item's acceptance
   criteria and end the body with your marker and verdict:
   `<!-- agent: <your name> verdict: ok -->` or
   `<!-- agent: <your name> verdict: changes -->`. Agents often share one
   GitHub account, where a review can only be a comment, so the marker is what
   counts; an unmarked review from that account does not. The one PR you never
   review is one you opened or pushed to in this same session. If your verdict
   is `ok`, turn on auto-merge in the same tick, unless the PR is
   `swarm/review-only`: its author merges it. Take a PR that is in focus
   (see "Focus") before one that isn't.
4. **Carry on unfinished work in focus.** A draft `swarm/pr` PR for a work
   item in focus (see "Focus") that no other agent is on, whoever opened it:
   lock it, read what it says is left, and continue on its branch. Finishing
   comes before starting. A draft for work outside focus waits until its work
   item is in focus again; non-draft PRs outside focus are still fixed and
   reviewed (steps 1 and 3), so written work lands.
5. **Start one new work item in focus** (see "Focus"): one in Todo (or In
   Progress with nobody on it and no PR open) that has no `swarm/agent/*`
   label, has no open sub-issues (someone split it into them by hand: take
   one of those), has no open blockers, and
   that you can take (see "What you may take") and that is not waiting for
   shaping (`swarm/needs-shaping` or `swarm/design`), taken in the order "Focus"
   gives. Nothing outside focus is started. Lock it, read it with its
   comments (`agent.mjs show <key>`), then build it; one back from QA gets
   only the fix its feedback asks for (see "Where the work is"). A work item's blockers are the items Linear's
   "blocked by" relation names, and those its description names after
   "Blocked by" (`COU-40`, an old key like `COUCHYUX-40`, or `#640` for the
   GitHub issue a work item was copied from); it is blocked while any of them
   is open. A GitHub issue that no work item was copied from was
   closed before the work moved, and blocks nothing. Before any of those,
   take whatever your repository's `AGENTS.md` puts ahead of the queue.
6. Otherwise there is nothing to do, even if work outside focus is ready.
   Say so and stop.

### When a tick ends

A tick has two times, both counted from when it started:

- **The limit, 20 minutes** (`AGENT_TICK_MINUTES`): until then you keep taking
  jobs. Finishing a job is never a reason to stop.
- **The ceiling, 45 minutes** (`AGENT_TICK_CEILING`): the hard stop. By then
  you have wrapped up and ended, whatever you were doing.

So a tick ends when it is past the limit with no job under way, when nothing is
left to do (step 6), or at the ceiling.

**Before you start a job, judge whether it fits.** Estimate how long it will
take you from start to pushed-and-PR-updated, and start it only if that ends
before the ceiling. A review usually fits; a large work item started at
minute 18 does not.

- If the job at the top of the list doesn't fit, take the next one down that
  does. If none fits, end the tick.
- A work item too big for a whole tick is never a reason to skip it forever.
  At the start of a tick, take it and build the first slice that fits, as a
  PR that says `Part of COU-<n>`; the next tick builds the next slice.
- Past the limit, start nothing new. A job already under way carries on, up
  to the ceiling.

**The ceiling is a hard stop, so don't meet it mid-thought.** About five
minutes before it, stop adding and wrap up. If you misjudged and the job isn't
complete, hand it over rather than push on: a draft PR and a comment on the
work item with what is done, what is left and what you learned.

**End every tick cleanly**, for whichever reason it ends:

- Everything you changed is committed and pushed; nothing lives only in your
  sandbox.
- Each work item you worked on has a PR (a draft if it isn't ready for
  review) whose body says what is done and what is left, well enough for an
  agent that has never seen it to carry on.
- **Your label is off everything.** Take it off each work item and PR as you
  finish with it, and off whatever is left when the tick ends (`finish`).
  A label left on tells every other agent to keep away from work nobody is
  doing; the sweep takes it off after 90 minutes.
- Your heartbeat comment says what you did this tick.

One thing carries over between the jobs of one tick: **you don't review a PR
you opened or pushed to in this tick.** It needs a session that comes to it
fresh; leave it for another agent or your next tick.

With a GitHub token and Linear credentials, every job `next` prints carries the command to run when it
is done (its `then` field) and `minutesToCeiling`, the time you have left to
judge the next job against. `more` answers with the next job or with why the
tick is over. It first takes your label off what you were on, since that job
is done. It never locks: when it offers a job with a `lock` number and you
judge that it fits, run `claim <number>` yourself. Pass `more`
`--wrote=<PR numbers>` for the PRs you opened or pushed to this tick, and run
`finish` when the tick ends without a last `more`.

With both, one command does the choosing and the claiming and prints
the job as JSON, with the `repo` it is in. A work item's job names it by key
(`"issue": "COU-12"`) with its `url`; a PR's by number:

```bash
AGENT_NAME=codex node ../swarm/agent.mjs next
```

`AGENT_CAN=ios-sim,design` lists what your sandbox has (see below), and
`next --look` chooses without locking. `claim <work item or PR>` and
`release <work item or PR> "why"` do one step each: `claim COU-12` for a
work item, `claim 57` for a PR, and `claim getcouchy/couchy-agent#57` for a PR
outside your home repository. Hand a work item or PR off with
`needs-human <work item or PR> "<question>"`, or a PR with
`hold <PR> "<what it waits for>"`: each posts the comment, then adds the
label (or moves a work item to Needs Human), and records the handoff as it
happens. A label put on by hand still
works, and the sweep still sees it.

### By hand

An agent without the tools follows the same steps with what it has: Linear's
API or MCP server for work items, its GitHub tools for pull requests. A
Claude cloud session that can't reach Linear takes no work item and does
only the pull request steps (1 to 4).

- **Lock:** read the labels of the work item or PR. If it has a `swarm/agent/*`
  label, leave it. Otherwise add yours (in Linear add the one label in the
  `swarm-agent` group, `issueAddLabel`, rather than writing the whole list
  back; if Linear refuses it, another agent's is on and you leave it), then
  **read the labels again**. If
  another agent's label appeared at the same moment, the alphabetically first
  name keeps it (`swarm/agent/claude` before `swarm/agent/claude-2` before
  `swarm/agent/codex`) and the other removes its own label and moves on.
- **Unlock:** remove your label when you finish with the item, and from
  everything at the end of the tick.
- **Heartbeat:** on the open work item labelled `swarm/desk` that belongs
  to your home repository, keep one comment that
  ends with `<!-- agent-heartbeat: <your name> -->`, and edit it each tick to say
  when you last ran. The sweep reports an agent whose comment goes stale.

## While you are on a work item

- Open the pull request early, as a draft if need be, with
  `Closes COU-<n>` in its body (or `Part of COU-<n>` for one slice
  of a large work item), a link to the work item, and the `swarm/pr` label.
  While that PR is open the work item is in progress there and is not offered
  as new work; the PR is what the next agent carries on. The sweep links the
  PR from the work item and moves the item to Done when a PR that closes it
  merges.
- Keep the PR body current: what is done, what is left, anything you learned
  that the next agent would otherwise have to find out again.
- If you stop before there is anything worth a PR, take your label off and
  comment on the work item with why and what you learned. It goes back in the
  queue.
- A lock is only for the length of a tick. The sweep removes any that has
  been on for 90 minutes (`AGENT_CLAIM_MINUTES`), on a work item or a PR.
- New work you find goes into Linear as a work item in Backlog, never as a
  GitHub issue. The owner decides when it is ready.

## Merging

The person who owns these repositories does not want to be the step everything
waits on. **Auto-merge is the default.** Every `swarm/pr` PR gets auto-merge
(squash) as soon as a review says `ok`, and GitHub merges it once the required
checks pass. Turning it on needs no reason and no ask; leaving it off needs a
reason from the list below, written on the PR. This section is the owner's
standing instruction to every agent working here.

- **Where `reviewed` is a required check, turn auto-merge on when you open the
  PR** (when it leaves draft, if it started as one). The `reviewed` status on
  the PR's head is GitHub's own record of the review: green once the latest
  verdict is `ok`, waiting until then and while `swarm/needs-human` or `swarm/hold`
  is on the PR, red on `changes`. GitHub won't merge without it, so auto-merge
  can go on at once and nobody has to turn it off again. A repository's
  required checks are in its branch rules; the tick tool reads them for you
  and offers the `merge` job.
- **Where it isn't required, `verdict: ok` turns auto-merge on.** The reviewer
  does it in the same tick; if the reviewer couldn't, the next agent to tick
  does (step 2). A `changes` verdict turns it off if it is on.
- **The verdict.** Give `ok` when the PR meets its work item's acceptance criteria
  and what remains is small enough to note for a follow-up. Give `changes`
  only for something that must be fixed before it ships, and say exactly what.
- **Never merge by hand, and never around a failing or unfinished check.**
  Auto-merge is the only way an agent merges.

### The exceptions

These are all of them. Each has a label, so the next agent's tick leaves the
PR alone instead of turning auto-merge back on:

| Reason not to merge yet | Mark it with | Who lifts it |
| --- | --- | --- |
| A person has to do something first: set a prod secret, back up data, sign in on a device | `swarm/needs-human`, and what to do at the top of the PR body | the person |
| The PR is one side of a real fork (see "When to call a person") | `swarm/needs-human`, after the comment that asks | the person |
| Merging it can't be undone by a revert: it drops or rewrites stored data, spends money, or weakens who can see or do what | `swarm/needs-human` | the person |
| It loosens what guards a merge (a required check, the review rules in getcouchy/swarm, this section) and the owner didn't ask for that change | `swarm/needs-human` | the person |
| It must land after something else: another PR, a release, a change in another repository | `swarm/hold`, and a comment naming what it waits for | any agent, once that has happened |
| You reviewed it `ok` but one fresh read isn't enough for what it touches (sign-in, permissions, a migration that changes existing rows) | `swarm/hold`, and a comment asking for a second review | the second reviewer, with their `ok` |
| It isn't finished | keep it a draft | its author |

`swarm/needs-human` pages the owner; `swarm/hold` pages nobody, so use it for a wait
an agent can end. Where `reviewed` is required, the label alone holds the
merge and lifting it releases it. Where it isn't: with either label on a PR,
don't turn auto-merge on, and turn it off if you find it on; whoever lifts
`swarm/hold` removes the label and, if the latest verdict is still `ok` and
nothing else on the list holds the PR, turns auto-merge on in the same step.

These are not reasons: the PR is large, it touches a hotspot file, no person
has looked at it, you have a doubt you can't name, the review left follow-ups.
Name the doubt as a `changes` verdict or let it merge.

A PR without `swarm/pr` is a person's: never review, fix or merge it. One with
`swarm/review-only` is a person's too, which you review and nothing more.

If the provider that runs you won't let you turn on auto-merge without its
user's own ask, and your prompt hasn't given it, leave your `ok` verdict; the
next agent's tick does step 2.

## When to call a person

Decide what you can. A question with a likely right answer is yours to answer:

- **Take the recommended answer and keep going** when the spec, the work item, the
  code's conventions or plain good practice point one way, or when either
  answer is cheap to change later. Write it in the PR body under
  "Decisions made": the question, what you chose, and why. That list is how
  the person checks afterwards; don't ask first.
- **Call a person only at a real fork:** no answer is clearly better, and the
  choice is costly to reverse or is theirs by nature: product direction the
  spec doesn't settle, deleting or migrating data that can't be restored,
  spending money, weakening security, or anything only they can do (a prod
  setting, a credential, access you don't have).
- **When you do call:** comment with the options, what each costs, and the one
  you would pick, then move the work item to Needs Human, or put
  `swarm/needs-human` on the PR (`agent.mjs needs-human` does both steps, in
  that order). Comment first:
  the label pages the owner at once, with your latest comment as the text, so
  open it with the question in a sentence they can answer from their phone. Then build the
  safe side of the fork if there is one, or move on to other work. Don't
  guess at a real fork, and don't wait silently.

## Focus

The owner says what matters most with the team's **current cycle** (the
sprint) in Linear, and the `swarm/focus` label on a single work item. A work
item is in focus when it is in the sprint or carries the label, when it is a
sub-issue of one that is (Linear's parent link, up to three levels down), or
when one of those waits on it: its blockers, their blockers, and so on, so a chain
in the sprint is worked from its first open link. Naming a work item in a
description ("Part of COU-12", a list of next steps) does not put it in
focus.

Step 5 starts only work in focus, in this order:

1. **Priority**, as Linear has it: urgent, high, medium, low, then none.
2. **What waits on it**: between equal priorities, the item more open work is
   waiting on, counted down the whole chain: every item whose "Blocked by"
   line or Linear "blocked by" relation names it, those that name them, and so
   on.
3. Equal on both: any of them.

When nothing in focus can be claimed (all held, blocked, or needing what you
lack), start nothing. Focus changes nothing in steps 1 to 3: PRs that need
work, auto-merge and reviews still come first, in or out of focus. Only the
owner plans the sprint, sets priorities, and adds or removes the label.

## Builder ticks

Some scheduled tasks exist only to build what is in focus. Their prompt says
"run your **focus tick** as `<name>`" (with the tool: `AGENT_ROLE=focus`).
A builder is an agent like any other, with a name and label of its own
(`swarm/agent/codex-focus-1`), and everything in this file applies to it
except the tick's steps, which for a builder are:

1. **Fix a pull request in focus that needs it** (step 1, for PRs in focus).
2. **Turn auto-merge on for a PR in focus** where "Merging" says to.
3. **Carry on unfinished work in focus** (step 4, for drafts in focus).
4. **Start one new work item that is in focus** (step 5). If none can be taken,
   stop.

What sets a builder apart is that it reviews nothing, and fixes and merges only
PRs in focus. The other ticks do
the reviewing, and they review a PR that is in focus (it closes, or is part
of, a work item in focus) before any other, so the builders' work merges without
waiting behind the rest.

## Shaping ticks

A shaping tick makes work ready to build; it builds nothing. Its prompt says
"run your **shaping tick** as `<name>`" (with the tool: `AGENT_ROLE=shape`).
It has a name and label of its own (`swarm/agent/claude-shape-1`) and, like
every tick, takes one job at a time until its time is spent: the work item
it already holds, else the next one the owner labelled `swarm/needs-shaping`
or `swarm/design` that is in Backlog or Todo, nobody holds, and is not
`swarm/hands-off`. Labelled work in focus comes
first; then priority; then the item more open work waits on. It reviews,
fixes and merges nothing, and never moves a work item's state, but to close
one its slices replace (below): the owner moves shaped work to Todo, and
that is the approval. While an item carries
either label no tick builds it, even in Todo.

Read the work item, its comments and its images first: `agent.mjs show
<key>`, then `agent.mjs images <key>` and read each file it saves. On a
second pass (the owner put the label back), the comments since your last
`shaped` comment are what to change.

**`swarm/needs-shaping`** asks for a work item an agent can build without asking
anything. Rewrite its description with `agent.mjs describe <key> <file.md>`
(the old one is kept in a comment), keeping what the owner wrote that still
holds, in this shape:

- the problem or goal in a paragraph, with the spec, design and parent it
  belongs to (`Part of COU-12`, a couchy-design spec by path);
- `### Scope`: what to build, concretely enough to start on;
- `### Not in this item`: what a reader might expect that belongs elsewhere;
- `### Acceptance`: observable checks a reviewer can tick, citing any
  `web-ergonomics` rules by number for web work;
- `### Verify`: how to show it works (the test, the smoke flow, the
  simulator flow);
- `Blocked by COU-…` when something must land first, also set as a
  Linear relation (`agent.mjs blocked-by <key> <keys>`).

Set the product labels it needs, one from each group (`agent.mjs labels <key>
-area/api +area/app +platform/web`): its `area`, its `platform`, its `repo`
when it isn't getcouchy/couchy, and `swarm/needs/<thing>` when it can't be
checked without it.

Work too big for one PR of a day or less becomes **slices**: work items of
their own beside the item, never sub-issues of it. Set the item's labels
first, then create each slice with `agent.mjs create <key> <file.md>` (first
line `# <title>`). A slice is made in Backlog, already `swarm/shaped`, with
the item's project, priority and sprint, and its product labels (those
Linear hasn't retired), `swarm/focus` and `swarm/needs/<thing>`.
`--labels=area/api,-platform/web` changes the labels for one slice: a label
takes the place of the item's in the same group, and `-<name>` leaves one of
the item's off. `--priority` gives it another priority. `--blocked-by` names
what it waits for: other slices, and whatever blocks the item.

The item doesn't stay behind to hold its slices. It ends one of two ways:

- **One slice finishes the work**, every other slice landing before it: the
  item becomes that slice. Don't create it. Rewrite the item as it with
  `agent.mjs describe <key> <file.md> --title="<the slice's title>"`, then
  `agent.mjs blocked-by <key> <the slices it waits for>`. Whatever waited on
  the item, and every older name for it, then waits for all of the work.
- **The work ends in several slices at once**: create them all, and finish
  with `agent.mjs shaped <key> "<summary>" --replaced-by=<every slice's
  key>`. Whatever waited on the item then waits on the last slices (those no
  other slice waits on), and the item is closed as Canceled with a comment
  that lists them. A closed item blocks nothing, so never close one any
  other way.

Don't create work outside the item you hold.

**`swarm/design`** asks for the grooming and the design. Clone
getcouchy/couchy-design beside your checkout, read its `README.md` and
`AGENTS.md`, and open one PR there (`swarm/pr` is not for it: the owner
reviews and merges design PRs) that adds `features/<slug>/spec.md` from
`features/_template/` with `Status: Draft` and its wireframes,
`wireframes/NN-<screen>.html`, at the sizes the README gives. Render each
wireframe to PNG (`npx -y playwright screenshot --viewport-size "1440, 900"
--full-page file://$PWD/<file>.html <file>.png`, or 390 × 844 for a phone
frame) and attach the PNGs to the work item (`agent.mjs attach <key>
<file.png>…`), so the owner can review in Linear. The groomed description
points at the spec by path and at the PR. The spec's open questions go in
the spec; a question the design can't proceed without goes to the owner with
`agent.mjs needs-human <key> "<question>"`, which moves the item to Needs Human,
and the tick moves on.

**Done:** `agent.mjs shaped <key> "<summary>"` comments the summary (what
changed, the slices, the design PR, and anything the owner should decide),
swaps `swarm/needs-shaping` or `swarm/design` for `swarm/shaped`, and takes your lock
off. With `--replaced-by` it closes the item instead of marking it shaped
(above). Shaping that isn't finished when the tick ends stays locked until
`finish`, keeps its label, and the next shaping tick carries it on from the
comments and the PR.

## What you may take

- `swarm/needs/<thing>` on a work item (in Linear `needs-<thing>` in the
  `swarm` group) means the work can't be checked without it:
  `swarm/needs/ios-sim` (a simulator), `swarm/needs/design` (read access to couchy-design).
  Take it only if your sandbox has that.
- Nothing else holds a work item back. Which agent takes it doesn't matter:
  every session starts from the same work item, spec and code. Several agents
  may hold items with the same `area/*` label at once; the label says what
  part of the product an item is in. If two PRs touch the same lines, the second to merge
  gets `conflicts-with-main` and its author merges `main` in (step 1).
- Sessions that share one name share one label, so they can't tell each
  other's locks apart. Give every scheduled task or coordinator that should
  work on its own a name of its own; sessions that do share a name tick one
  after another, not at once.

## What watches the agents

A scheduled job runs `sweep.mjs` for a home repository. For getcouchy/couchy
it is a CronJob on kube-1, every 10 minutes (that repository's `docs/ci.md`,
"Agent sweep"). It removes a lapsed claim and settles a doubled one, keeps
`swarm/blocked` on the open work items that have an open blocker, moves
work items with their pull requests (In Progress from Todo, never Backlog, with
a link while one is open, QA or Done once one that closes them merges), and it keeps the **Agent desk**
work item in Linear current with whatever is overdue: a ready work item in focus
no agent has taken, a PR without a review, a failing PR its author left, a PR
reviewed `ok` with auto-merge still off, one held with `swarm/hold` for a day, anything
waiting on a person (a work item in Needs Human, a PR labelled `swarm/needs-human`;
with the work items it holds up, those in focus marked), work waiting in QA, work waiting for a shaping tick, shaped work in
Backlog waiting for the owner, an agent that stopped ticking. A shaping
tick's lock on a Backlog item is expected; any other tick's is listed.

Another job there runs `reviewed.mjs` every 2 minutes and posts the `reviewed`
status ("Merging") on every open PR's head. A PR whose newest head has no
`reviewed` status after a few minutes means that job is failing, not that the
review is missing: say so in your heartbeat.

`page.mjs` sends the page for `swarm/needs-human` on a PR. In getcouchy/couchy it is
not running today (`docs/ci.md`, "Needs-human page"), so the label reaches the
owner through the desk's "Needs you" list alone. Use it as this file says all
the same.
