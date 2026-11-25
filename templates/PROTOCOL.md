# The agent protocol

Several coding agents (Claude, Codex, Grok…, sometimes more than one of each)
work in {{#if org}}the {{org}} repositories{{/if}}{{#unless org}}the same repositories{{/unless}} at once. They can't message each other, so
Linear and GitHub are the only shared state: the work is in Linear, the pull
requests are on GitHub, labels on both say whose turn it is, and this file is
the protocol every agent follows, whatever its provider.

Each repository that uses it has an `AGENTS.md` that points here and adds what
is its own: its code conventions, its rules for pull requests, and any work it
puts ahead of the queue. Those apply to every agent, not only the one whose
provider reads that file by name, and where they say more than this file they
win for that repository.

## Where the work is

**Work items are in Linear**{{#if linear.url}} ({{linear.url}}, workspace `{{linear.workspace}}`){{/if}}.
{{#if teams}}{{teams}} {{/if}}A work item is a
Linear issue, named by its key, `{{KEY}}-12`. A team's work belongs to the
first repository the settings list for that team, unless a label in the
`{{g.repo}}` group (`{{g.repo}}/<the repository's name>`) names another.
Projects are the epics; the team's current cycle is the sprint.

{{note:where-the-work-is}}

**Pull requests are on GitHub**, and so are their reviews, checks and labels.
GitHub's issues are not the swarm's: don't read the queue there, don't open
issues there, and don't close or edit any that are there.

The tools read `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` (README.md has
the others, and the settings every name in this file comes from). An agent without the tools uses Linear's GraphQL API
(`https://api.linear.app/graphql`, header `Authorization: Bearer <token>`, or
the bare key for a personal one) or the Linear MCP server. A sandbox that
can't reach Linear can review and fix pull requests, but takes no work item.

What a work item's state means here:

| State | Means |
| --- | --- |
| Backlog | not ready: being broken down, or waiting on the owner's approval |
| Todo | ready for an agent to take |
| In Progress, In Review | an agent has it, or a pull request for it is open, or it is split and its sub-issues are being built (see "Splitting a work item"); with none of these, it is ready again |
| {{state.needsHuman}} | waiting on a person: an agent asked a question only they can answer, or needs a step only they can take (see "When to call a person"); no agent takes it |
| {{state.qa}} | waiting on the owner's review; no agent takes it. Either a pull request that closes it merged and the owner is walking its acceptance criteria (QA), and it blocks nothing; or it is a technical design whose pull request waits for the owner to merge it, and it blocks until then |
| Done | a pull request that closes it merged, and it needed no QA or passed it |
| Canceled | not doing it |

The owner moves work from Backlog to Todo; that is the approval. The tools
move it to In Progress when an agent claims it, and the sweep moves it from
Todo to In Progress while a pull request for it is open. Nothing moves work
out of Backlog but the owner, even with a pull request open for it, except the
parts an agent splits approved work into. When one that closes it merges, the sweep
moves it to {{state.qa}} if it changes what people see and use, and to Done if not:
{{state.qa}} when it carries `{{l.qa}}`{{#if qa.labels}}, {{qa.labels}}{{/if}}{{#if qa.skipLabels}},
or none of {{qa.skipLabels}}{{/if}}{{#unless qa.skipLabels}}; the settings
name no label that skips it, so every item does{{/unless}}. A part of a split item
goes to Done, and the item itself to {{state.qa}} or Done after its last part. Add
`{{l.qa}}` to backend work whose result people will notice; nothing takes
work out of {{state.qa}} but the owner, who moves it to Done when it passes, or back to
Todo with a comment saying which criterion failed. Nothing takes work out of
{{state.needsHuman}} but the owner either, who moves it on (to Backlog or Todo) once
they have answered. Don't move a work item to {{state.qa}} or Done yourself (`submit` moves
a technical design to {{state.qa}}, and a "Task breakdown" item to Done), or to
{{state.needsHuman}} but with `needs-human`.

An item back in Todo from {{state.qa}} is not new work: what shipped stays, and you fix
only what the owner's comment says failed, on a fresh branch, in a new PR that
says `Closes <key>`. `next` tells you when an item came back (the job's
`returned`: the merged PRs and the comments since); with no comment saying
what failed, ask with `needs-human` rather than guess.

**Labels in Linear are in groups.** The swarm's are in two: `{{g.agent}}`,
whose labels are the locks (`claude-1`, `codex-1`), and `{{g.protocol}}`
(`{{c.taskBreakdown}}`, `needs-ios-sim`, `{{c.blocked}}`, …). The product's are in groups of
their own: `{{g.repo}}`, and whatever else it sorts work by (`area`, `platform`).
This file names a label by its group and name,
as Linear's filters do: `{{g.repo}}/api`, `area/app`, `{{l.taskBreakdown}}`.
A lock is the exception: `claude-1` in `{{g.agent}}` is what GitHub calls
`{{l.agent}}claude-1`, and this file calls it that. Every group but `{{g.protocol}}`
takes **one label per work item**: Linear refuses a second, so an item has one
repository, one area, one platform and one lock. To change one, take the old
label off first (`agent.mjs labels {{KEY}}-12 -area/app +area/api`). The tools make
a label they need in its group the first time it is used.

## Your name

The prompt that wakes you names you: "run your tick as `claude-2`". That name
is who you are here, and `{{l.agent}}<your name>` (`{{l.agent}}claude-2`) is
your label: on GitHub under that name, in Linear as `claude-2` in the
`{{g.agent}}` group.
A name is lower-case letters, digits and hyphens, and whoever sets up the agent
chooses it: `codex`, `grok`, `claude-2`, `claude-1-scheduled`.

- **Only the exact label is yours.** If you are `claude-2`, then `{{l.agent}}claude`
  is another agent's label, even though you are both Claude: what it is on
  right now, you leave alone.
- Use the name you were given even where another file (`CLAUDE.md`) names a
  default label. `{{l.agent}}claude` is the name of the Claude project agents, and
  the default only for a Claude session whose prompt gives it no name.
- If nothing names you, don't guess: do no claiming, and say so.
- **Your GitHub account.** A name can have a GitHub App of its own{{#if bot}},
  `{{bot}}<name>[bot]`{{/if}} (see [`README.md`](README.md)).
  If your sandbox has the `{{BOT}}_BOT_*` variables, run
  `eval "$(node ../swarm/bots.mjs env)"` at the start of each tick and
  `node ../swarm/bots.mjs git-setup` once per clone, so you push, comment
  and commit as your bot. Keep the review marker either way.

## The one rule

**A lock means an agent is working on this right now.** It is not ownership.
Take one on a work item or a pull request before you change anything for it
(`agent.mjs claim <work item or PR>`; `next` takes it for the job it hands
you), and release it when your tick ends (`release`, `more`, `finish`). While
another agent's lock is on something, don't touch it: no commits, no review,
no new work for that item. Never release another agent's lock.

A lock shows on the item as the label `{{l.agent}}<name>`, so anyone looking
at it can see who is on it, and an agent without the tools can take one by
hand ("By hand"). The rest of this file says "label" and "lock" for the same
thing.

Once the lock is off, the work is anyone's. Nothing here belongs to the
agent that started it: every session begins from the same work item, pull
request and code, whatever its name, so whoever ticks next carries on where
the last one stopped. That is why a tick must end with everything pushed and the PR
saying what is done and what is left (see "When a tick ends").

Two agents can ask for the same lock in the same moment. `claim` settles it
and says which of you has it: on a work item the tracker refuses the second,
and on a pull request the alphabetically first name keeps it ("By hand"). If
`claim` says you lost, leave the item.

**`{{l.handsOff}}` is the owner's.** On a work item or a pull request it means
the owner is doing this one: leave it entirely alone, however stale or red it
looks, until the label comes off. Only the owner adds or removes it.

A pull request the agents opened carries `{{l.pr}}` for its whole life. That
label, not the lock, is what makes it the swarm's to review, fix and merge.
Put it on every PR you open.

A person who wants the agents' review on their own PR, and nothing more, puts
`{{l.reviewOnly}}` on it. Review it like any other (step 3), and the
`{{status}}` check holds it to your verdict, but it stays its author's: never
push to it, fix it, continue it, or turn its auto-merge on or off. It wins
over `{{l.pr}}` when a PR carries both.

## The labels

Every label this protocol owns starts with `{{ns}}` on GitHub, and is in the
`{{g.protocol}}` or `{{g.agent}}` group in Linear. Anything else on a work item or a PR
(`{{g.repo}}/*`, `area/*`, `{{conflict}}`) belongs to the product or CI.

| Label | Means | Who sets it |
| --- | --- | --- |
| `{{l.agent}}<name>` | that agent is working on this work item or PR right now | the agent, for the length of its tick |
| `{{l.pr}}` | a PR the agents opened: theirs to review, fix and merge | the agent that opens it |
| `{{l.reviewOnly}}` | a person's PR the agents review, and the `{{status}}` check gates, but never fix, continue or merge | the PR's author or the owner |
| `{{l.focus}}` | a work item to take first, beside the sprint (see "Focus") | the owner only |
| `{{l.taskBreakdown}}` | make this work item ready to build: scope, acceptance criteria, labels, blockers, slices (see "PM ticks"); no tick builds it meanwhile | the owner only |
| `{{l.design}}` | break it down, and design it in {{design}}: spec and wireframes (see "PM ticks"); no tick builds it meanwhile | the owner only |
| `{{l.techDesign}}` | write the technical design for a merged spec, with its proposed issue sequence (see "Architect ticks"); no tick builds it, and no pm tick takes it. It stays on: the design is done when the work item is (Done, once the design's PR merges) | the owner, or {{design.name}}'s hand-off workflow when a spec merges |
| `{{l.qa}}` | when its closing PR merges, the work item goes to {{state.qa}}, not Done (see "Where the work is") | an agent or the owner; only the owner removes it |
| `{{l.blocked}}` | the work item waits on other work: an open blocker, for views to filter on; ask for the blockers yourself before taking work. Not the {{state.needsHuman}} state, which waits on a person | the sweep only; it takes off any it finds without an open blocker |
| `{{l.needsHuman}}` | on a PR: a real fork or a step only a person can take; pages the owner and holds the merge. A work item goes to the {{state.needsHuman}} state instead | an agent, after its comment |
| `{{l.hold}}` | holds a PR's merge for a wait an agent can end; pages nobody | an agent, with a comment |
| `{{l.handsOff}}` | the owner is handling this work item or PR: no agent starts, fixes, continues, reviews or merges it | the owner only |
| `{{g.protocol}}/needs-<thing>` | (any but `{{c.needsHuman}}`) the work can't be checked without `<thing>` (see "What you may take"); the tools call it `{{l.needs}}<thing>` | whoever writes the work item |
| `{{l.desk}}` | marks the Agent desk work item | the sweep |

{{#if aliases}}
Some of these had other names before: {{aliases}}. The tools still read the
old names, and the sweep renames any it finds, but write only the new ones.
{{/if}}
The sweep moves a work item still labelled `{{l.needsHuman}}` to {{state.needsHuman}}.

## The repositories

{{#if repos}}
The swarm works in {{repos}}.
{{/if}}
{{note:repositories}}

The same labels mean the same things in every repository the swarm works in. A
work item for one is often blocked by one for another: Linear's "blocked by"
relation says so, or its description ("Blocked by {{KEY}}-40").

A tick covers the repositories its scheduler gives it: the ones its prompt
names, which with a token are `AGENT_REPOS` (comma-separated; the runner
sets it from the tick's `repos` list; default: the repository you work in, then
the others the settings list). The first is its **home repository**: its
open `{{l.desk}}` work item belonging to it is the Agent desk your heartbeat
goes on. Go through the steps below across all of them, taking the first step
that applies anywhere before a later step somewhere else. A PR goes to the
repository its work item belongs to, and follows that repository's own
`AGENTS.md` for the rest.

A tick can reach only the repositories its sandbox was given. One it can't read
it passes by.

## Roles

A tick runs as one role. Its prompt says which, and with the tools `AGENT_ROLE`
does; a prompt that names none is a general tick.

| Role | `AGENT_ROLE` | The prompt says | Does |
| --- | --- | --- | --- |
| **General** | unset, or `general` | "run your tick" | every step of "Your tick": fixes, merges, reviews, carries on and builds |
| **Builder** | `builder` | "run your builder tick" | builds what is in focus, and reviews nothing ("Builder ticks") |
| **PM** | `pm` | "run your pm tick" | breaks work down until an agent can build it, and builds nothing ("PM ticks") |
| **Architect** | `architect` | "run your architect tick" | writes a feature's technical design, and builds nothing ("Architect ticks") |

A prompt or a variable written before these names still works: "focus tick"
and `focus` are the builder, "task-breakdown tick" or "shaping tick" and
`task-breakdown` the pm, and "regular tick" the general one.

A run that is handed one work item (a bug report, say) is not a role of its
own. It follows a builder's rules for that item alone: it takes no other job,
and whoever starts it says which item it is.

## Your tick

Your scheduler wakes you with "run your tick as `<your name>`". Note the time
you start. A scheduled task whose prompt points you to
[`TICK.md`](TICK.md) sets up its session as that file says.

**First, get current.** The protocol and its tools change often, and a
checkout left from yesterday follows yesterday's rules. Clone
{{tools}} beside the checkout you work in at the start of every tick
(`git clone --depth 1 {{tools.url}} ../swarm`; it is
public, so no access is needed), or `git -C ../swarm pull --ff-only` a clone
you keep, and read this file from there and your repository's `AGENTS.md`
from a fresh checkout of its `{{base}}`. If
you work in a checkout that outlives the tick:

- On `{{base}}` with nothing uncommitted (untracked files don't count):
  `git fetch origin`, then `git merge --ff-only origin/{{base}}`, before you set up your bot and before you
  read its `AGENTS.md` for the tick. `agent.mjs next` does this itself, and
  every `agent.mjs` command runs `origin/main`'s copy of the tools even from an
  old clone of {{tools}}. A detached checkout of `origin/{{base}}` (a fresh
  worktree) counts the same; move it with `git checkout --detach origin/{{base}}`.
- On another branch, with uncommitted changes, or on a `{{base}}` with commits
  `origin/{{base}}` lacks: don't pull over it, and take no new work yet (`next`
  hands you the checkout itself as the job and claims nothing). Find out
  what it is first. It is most likely unfinished work: the branch of an open
  PR, or the start of a work item with no PR yet (`next` names the likeliest).
  If it is the swarm's and no other agent's label is on it, lock it, push what
  is finished (a draft PR that says what is left), then start the tick from a
  clean `{{base}}`. If another agent is on it now, or it is a person's PR, touch
  nothing. If nothing explains it, don't discard it. In both of those cases
  say so in your heartbeat and run the tick from a fresh worktree of
  `origin/{{base}}`.

Then do the first of these that applies; when it is done, come back to
the top and do the next, until the tick ends (see "When a tick ends"):

1. **Fix a pull request that needs it.** An open, non-draft `{{l.pr}}` PR
   that no other agent is on, with a failed check, the `{{conflict}}`
   label, or a review whose verdict is `changes` since its last push. It
   doesn't matter who opened it. Lock it, check out its branch, fix it, push.
   A held PR is not one: with `{{l.needsHuman}}` leave it until the person
   answers, and with `{{l.hold}}` a failed check or a conflict waits for what
   the PR is held for. Only a `changes` verdict on a `{{l.hold}}` PR is work.
2. **Keep auto-merge right.** It is the default for every `{{l.pr}}` PR (see
   "Merging"). Where `{{status}}` is a required check, any non-draft one with
   auto-merge off: turn it on. Where it isn't, turn it on for one whose latest
   review verdict is `ok` with nothing from the exceptions list holding it,
   and turn it off for one that is now held (`{{l.needsHuman}}`, `{{l.hold}}`, a
   later `changes` verdict).
3. **Review a pull request.** An open, non-draft `{{l.pr}}` or
   `{{l.reviewOnly}}` PR that nobody is working on right now and that nobody has reviewed, or that has been pushed
   to since a `changes` verdict. Review it against its work item's acceptance
   criteria and end the body with your marker and verdict:
   `<!-- agent: <your name> verdict: ok -->` or
   `<!-- agent: <your name> verdict: changes -->`. Agents often share one
   GitHub account, where a review can only be a comment, so the marker is what
   counts; an unmarked review from that account does not. Leave the verdict in
   a PR review. A comment with the verdict marker counts as well. Either counts
   only from someone who may push to the repository, or an agent's own App.
   The one PR you never
   review is one you opened or pushed to in this same session. If your verdict
   is `ok`, turn on auto-merge in the same tick, unless the PR is
   `{{l.reviewOnly}}`: its author merges it. Take a PR that is in focus
   (see "Focus") before one that isn't.
4. **Carry on unfinished work in focus.** A draft `{{l.pr}}` PR for a work
   item in focus (see "Focus") that no other agent is on, whoever opened it:
   lock it, read what it says is left, and continue on its branch. Finishing
   comes before starting. A draft for work outside focus waits until its work
   item is in focus again; non-draft PRs outside focus are still fixed and
   reviewed (steps 1 and 3), so written work lands.
5. **Start one new work item in focus** (see "Focus"): one in Todo (or In
   Progress with nobody on it and no PR open) that has no `{{l.agent}}*`
   label, has no open sub-issues (it is split: take one of those, and see
   "Splitting a work item"), has no open blockers, and
   that you can take (see "What you may take") and that is not waiting for
   a pm or architect tick (`{{l.taskBreakdown}}`, `{{l.design}}` or `{{l.techDesign}}`), taken in the order "Focus"
   gives. Nothing outside focus is started. Lock it, read it with its
   comments (`agent.mjs show <key>`), then build it; one back from {{state.qa}} gets
   only the fix its feedback asks for (see "Where the work is"). A work item's blockers are the items Linear's
   "blocked by" relation names, and those its description names after
   "Blocked by" (`{{KEY}}-40`, a key the item had before a move, or `#640` for the
   GitHub issue a work item was copied from); it is blocked while any of them
   is open. A GitHub issue that no work item was copied from was
   closed before the work moved, and blocks nothing. Before any of those,
   take whatever your repository's `AGENTS.md` puts ahead of the queue.
6. Otherwise there is nothing to do, even if work outside focus is ready.
   Say so and stop.

### When a tick ends

A tick has two times, in minutes counted from when it started. Each is its
environment variable's value where that is set, whatever the default:

- **The limit** (`AGENT_TICK_MINUTES`, {{tick.minutes}} by default): until then you keep
  taking jobs. Finishing a job is never a reason to stop.
- **The ceiling** (`AGENT_TICK_CEILING`, {{tick.ceiling}} by default): the hard stop. By then
  you have wrapped up and ended, whatever you were doing.

So a tick ends when it is past the limit with no job under way, when nothing is
left to do (step 6), or at the ceiling.

**Before you start a job, judge whether it fits.** Estimate how long it will
take you from start to pushed-and-PR-updated, and start it only if that ends
before the ceiling. A review usually fits; a large work item started
late does not.

- If the job at the top of the list doesn't fit, take the next one down that
  does. If none fits, end the tick. Pass over a job because it won't fit the
  time left, or because nothing you can do now moves it (what it needs is held
  or down): never because it is hard or dull.
- A work item too big for a whole tick is never a reason to skip it forever.
  At the start of a tick, take it, split it into sub-issues (see "Splitting a
  work item") and build the first that fits; the next tick builds the next.
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
  doing; the sweep takes it off after {{claim.minutes}} minutes.
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

To pass over a job, run the command in its `pass` field instead of `then`:
`more` with the job added to `--skip={{KEY}}-12,57`, which answers with the next one
down and takes your label off the one you passed over. It is passed over for
this tick only, so keep the list on every `more` that follows (each job's
commands carry it). Turning auto-merge on or off has no `pass`: it takes a moment.

With both, one command does the choosing and the claiming and prints
the job as JSON, with the `repo` it is in. A work item's job names it by key
(`"issue": "{{KEY}}-12"`) with its `url`; a PR's by number:

```bash
AGENT_NAME=codex node ../swarm/agent.mjs next
```

`AGENT_CAN=ios-sim,design` lists what your sandbox has (see below), and
`next --look` chooses without locking. `claim <work item or PR>` and
`release <work item or PR> "why"` do one step each: `claim {{KEY}}-12` for a
work item, `claim 57` for a PR, and `claim {{other}}#57` for a PR
outside your home repository. Hand a work item or PR off with
`needs-human <work item or PR> "<question>"`, or a PR with
`hold <PR> "<what it waits for>"`: each posts the comment, then adds the
label (or moves a work item to {{state.needsHuman}}), and records the handoff as it
happens. A label put on by hand still
works, and the sweep still sees it.

### By hand

An agent without the tools follows the same steps with what it has: Linear's
API or MCP server for work items, its GitHub tools for pull requests. A
Claude cloud session that can't reach Linear takes no work item and does
only the pull request steps (1 to 4).

- **Lock:** read the labels of the work item or PR. If it has a `{{l.agent}}*`
  label, leave it. Otherwise add yours (add that one label, rather than
  writing the item's whole list of labels back; if the tracker refuses it,
  another agent's is on and you leave it), then
  **read the labels again**. If
  another agent's label appeared at the same moment, the alphabetically first
  name keeps it (`{{l.agent}}claude` before `{{l.agent}}claude-2` before
  `{{l.agent}}codex`) and the other removes its own label and moves on.
- **Unlock:** remove your label when you finish with the item, and from
  everything at the end of the tick.
- **Heartbeat:** on the open work item labelled `{{l.desk}}` that belongs
  to your home repository, keep one comment that
  ends with `<!-- agent-heartbeat: <your name> -->`, and edit it each tick to say
  when you last ran. The sweep reports an agent whose comment goes stale.

## While you are on a work item

- Open the pull request early, as a draft if need be, with
  `Closes {{KEY}}-<n>` in its body, a link to the work item, and the `{{l.pr}}`
  label. Work that needs a second PR is split first ("Splitting a work item");
  `Part of {{KEY}}-<n>` alone leaves what is left where nothing tracks it.
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
  been on for {{claim.minutes}} minutes (the settings' `sweep.claimMinutes`), on a work item or a PR.
- New work you find goes into Linear as a work item in Backlog, never as a
  GitHub issue. The owner decides when it is ready.

## Splitting a work item

**Work that takes more than one PR is split into sub-issues, one for each
PR.** Linear then shows what is done, what is being built and what is left; a
list in a PR body or a comment doesn't. Whether to split is yours to decide,
when you start the item or when you find part-way that it is too big. (A
pm tick's slices are another thing: work items beside the one it
holds, waiting for the owner's approval.)

**To split one you hold**, in Todo or In Progress:

1. Cut it into parts that each make one PR. Together they cover the whole of
   its Scope and every Acceptance check, **the part you are building now
   included**; the item closes when they are done, so what no part covers is
   lost. A check that only holds at the end (a count at zero, a rule's docs)
   goes in a last part, blocked by the others.
2. Write each part as a work item another agent can build without asking:
   `# <title>`, a paragraph of goal, then `### Scope`, `### Not in this
   item`, `### Acceptance` and `### Verify`, and any line your repository's
   `CLAUDE.md` asks of a sub-issue. A part only divides the item's scope. New
   work you find is a work item in Backlog, as always.
3. `agent.mjs create <key> <file.md> --sub` for each, in the order to build
   them, with `--blocked-by=<keys>` where one needs another to land first. It
   is made in Backlog, with the item's product labels, priority, project and
   sprint (`--labels` and `--priority` change them, as for a slice).
4. `agent.mjs submit <key> "<how you cut it>" --split=<every part's key>`
   moves the parts to Todo, lists them in a comment on the item, and takes your
   lock off it. The owner approved the item, so its parts need no second
   approval. Don't end the tick between steps 3 and 4: parts left in Backlog
   are built by nobody.
5. `agent.mjs claim` the part you build now. If a PR for the item is open
   already, its body now says `Closes` that part.

By hand: make each part with the item as its parent and the item's labels
(no `{{ns}}` label but `{{c.focus}}` and `needs-<thing>`), set its blockers, move
them all to Todo once the last is made, and leave the item In Progress.

**To build a part**, take it as any other work item. A part takes its item's
focus and its place in the queue, and its job's `partOf` names the item:
`agent.mjs show <item>` lists the other parts with their states, so read what
is done before you start. The item itself is not offered while a part is open.

- The PR says `Closes {{KEY}}-<part> (part of {{KEY}}-<item>)`. Its merge makes the
  part Done; that is how a part is marked done, so close nothing by hand.
- Never write `Closes` for the item, not even in the PR of the last part.
  Linear would close it at the merge, past {{state.qa}} and ahead of parts that are
  still open.
- A part goes to {{state.qa}} only if it carries `{{l.qa}}`: the owner walks the
  item, not each part.
- If you find something the parts miss, claim the item, add a part (steps 3
  to 5), and go on. A part that is itself too big is split the same way.
- `{{l.handsOff}}` on the item doesn't reach its parts: the owner puts it on
  each that is theirs.

**After the last part** the sweep moves the item to {{state.qa}} or Done by its own
labels, once no agent holds it and no PR for it is open. If the owner sends it
back to Todo it is offered again with the merged PRs and the owner's comment
(see "Where the work is"), and the fix's PR says `Closes {{KEY}}-<item>`.

**An item begun as `Part of` PRs with no sub-issues** (from before this rule,
or by an agent that missed it): before you build any more of it, read what its
merged PRs say is left and split that. What has merged needs no part.

## Merging

The person who owns these repositories does not want to be the step everything
waits on. **Auto-merge is the default.** Every `{{l.pr}}` PR gets auto-merge
({{merge.method}}) as soon as a review says `ok`, and GitHub merges it once the required
checks pass. Turning it on needs no reason and no ask; leaving it off needs a
reason from the list below, written on the PR. This section is the owner's
standing instruction to every agent working here.

- **Where `{{status}}` is a required check, turn auto-merge on when you open the
  PR** (when it leaves draft, if it started as one). The `{{status}}` status on
  the PR's head is GitHub's own record of the review: green once the latest
  verdict is `ok`, waiting until then and while `{{l.needsHuman}}` or `{{l.hold}}`
  is on the PR, red on `changes`. It also waits while the newest run of a required
  check that wasn't skipped or cancelled hasn't passed: GitHub takes a later
  skipped run (a label starts one) for a pass. GitHub won't merge without it, so auto-merge
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
| A person has to do something first: set a prod secret, back up data, sign in on a device | `{{l.needsHuman}}`, and what to do at the top of the PR body | the person |
| The PR is one side of a real fork (see "When to call a person") | `{{l.needsHuman}}`, after the comment that asks | the person |
| Merging it can't be undone by a revert: it drops or rewrites stored data, spends money, or weakens who can see or do what | `{{l.needsHuman}}` | the person |
| It loosens what guards a merge (a required check, the review rules in {{tools}}, this section) and the owner didn't ask for that change | `{{l.needsHuman}}` | the person |
| It must land after something else: another PR, a release, a change in another repository | `{{l.hold}}`, and a comment naming what it waits for | any agent, once that has happened |
| You reviewed it `ok` but one fresh read isn't enough for what it touches (sign-in, permissions, a migration that changes existing rows) | `{{l.hold}}`, and a comment asking for a second review | the second reviewer, with their `ok` |
| It isn't finished | keep it a draft | its author |

`{{l.needsHuman}}` pages the owner; `{{l.hold}}` pages nobody, so use it for a wait
an agent can end. Where `{{status}}` is required, the label alone holds the
merge and lifting it releases it. Where it isn't: with either label on a PR,
don't turn auto-merge on, and turn it off if you find it on; whoever lifts
`{{l.hold}}` removes the label and, if the latest verdict is still `ok` and
nothing else on the list holds the PR, turns auto-merge on in the same step.

These are not reasons: the PR is large, it touches a hotspot file, no person
has looked at it, you have a doubt you can't name, the review left follow-ups.
Name the doubt as a `changes` verdict or let it merge.

A PR without `{{l.pr}}` is a person's: never review, fix or merge it. One with
`{{l.reviewOnly}}` is a person's too, which you review and nothing more.

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
  you would pick, then move the work item to {{state.needsHuman}}, or put
  `{{l.needsHuman}}` on the PR (`agent.mjs needs-human` does both steps, in
  that order). Comment first:
  the label pages the owner at once, with your latest comment as the text, so
  open it with the question in a sentence they can answer from their phone. Then build the
  safe side of the fork if there is one, or move on to other work. Don't
  guess at a real fork, and don't wait silently.

## Focus

The owner says what matters most with the team's **current cycle** (the
sprint) in Linear, and the `{{l.focus}}` label on a single work item. A work
item is in focus when it is in the sprint or carries the label, when it is a
sub-issue of one that is in focus (Linear's parent link), or
when one in focus waits on it: its blockers, their blockers, and so on, so a chain
in the sprint is worked from its first open link. Naming a work item in a
description ("Part of {{KEY}}-12", a list of next steps) does not put it in
focus.

Step 5 starts only work in focus, in this order:

1. **Priority**, as Linear has it: urgent, high, medium, low, then none.
2. **What waits on it**: between equal priorities, the item more open work is
   waiting on, counted down the whole chain: every item whose "Blocked by"
   line or Linear "blocked by" relation names it, those that name them, and so
   on. For a part of a split item, what waits on the item counts too.
3. **Age**: equal on both, the oldest. A part is as old as the item it is part
   of, so finishing comes before starting.

When nothing in focus can be claimed (all held, blocked, or needing what you
lack), start nothing. Focus changes nothing in steps 1 to 3: PRs that need
work, auto-merge and reviews still come first, in or out of focus. Only the
owner plans the sprint, sets priorities, and adds or removes the label.

## Builder ticks

Some scheduled tasks exist only to build what is in focus. Their prompt says
"run your **builder tick** as `<name>`" (with the tool: `AGENT_ROLE=builder`).
A builder is an agent like any other, with a name and label of its own
(`{{l.agent}}codex-builder-1`), and everything in this file applies to it
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

## PM ticks

A pm tick makes work ready to build; it builds nothing. Its prompt
says "run your **pm tick** as `<name>`" (with the tool:
`AGENT_ROLE=pm`). It has a name and label of its own (`{{l.agent}}claude-pm-1`) and, like
every tick, takes one job at a time until its time is spent: the work item
it already holds, else the next one the owner labelled `{{l.taskBreakdown}}`
or `{{l.design}}` that is in Backlog or Todo, nobody holds, and is not
`{{l.handsOff}}`. Labelled work in focus comes
first; then priority; then the item more open work waits on. It reviews,
fixes and merges nothing, and never moves a work item's state, but to close
one it split or filed work from (below): the owner moves the finished work to Todo, and
that is the approval. While an item carries
either label no tick builds it, even in Todo.

Read the work item, its comments and its images first: `agent.mjs show
<key>`, then `agent.mjs images <key>` and read each file it saves. On a
second pass (the owner put the label back), the comments since your last
`submit` comment are what to change.

**`{{l.taskBreakdown}}`** asks for a work item an agent can build without asking
anything. Rewrite its description with `agent.mjs describe <key> <file.md>`
(the old one is kept in a comment), keeping what the owner wrote that still
holds, in this shape:

- the problem or goal in a paragraph, with the spec, design and parent it
  belongs to (`Part of {{KEY}}-12`, a {{design.name}} spec by path);
- `### Scope`: what to build, concretely enough to start on;
- `### Not in this item`: what a reader might expect that belongs elsewhere;
- `### Acceptance`: observable checks a reviewer can tick{{note:acceptance}};
- `### Verify`: how to show it works (the test, the smoke flow, the
  simulator flow);
- `Blocked by {{KEY}}-…` when something must land first, also set as a
  Linear relation (`agent.mjs blocked-by <key> <keys>`).

Set the product labels it needs, one from each group (`agent.mjs labels <key>
-area/api +area/app +platform/web`): its `area`, its `platform`, its `repo`
when it isn't {{home}}, and `{{l.needs}}<thing>` when it can't be
checked without it.

Work too big for one PR of a day or less becomes **slices**: work items of
their own beside the item, never sub-issues of it. Set the item's labels
first, then create each slice with `agent.mjs create <key> <file.md>` (first
line `# <title>`). A slice is made in Backlog, with
the item's project, priority and sprint, and its product labels (those
Linear hasn't retired), `{{l.focus}}` and `{{l.needs}}<thing>`.
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
  with `agent.mjs submit <key> "<summary>" --replaced-by=<every slice's
  key>`. Whatever waited on the item then waits on the last slices (those no
  other slice waits on), and the item is closed as Canceled with a comment
  that lists them. A closed item blocks nothing, so never close one any
  other way.

Don't create work outside the item you hold.

**A merged technical design.** The work item is "Task breakdown: <slug>", which
{{design.name}}'s hand-off workflow files when the owner merges a design, and its
`{{l.taskBreakdown}}` asks you to file the design's work items. Clone
{{design}} beside your checkout and open
`features/<slug>/tech-design.md` on `main` (the description names it). The
"Technical design" work item is done: leave it as it is. Its "Proposed issue sequence" is already cut and written by the
architect: you copy it, you don't redesign it. For each entry, in order:

1. Write its file: `# <the entry's title>`, then its goal paragraph with a
   line naming the technical design and the spec by path, then its body with
   each `####` heading made `###`. Under `### Design`, after what is there,
   paste in full every contract its "Contracts" line names, from the design's
   Contracts section. A builder's sandbox may not reach {{design.name}}, so
   nothing is left as a link.
2. `agent.mjs create <key> <file.md> --labels=<its Labels line>
   --blocked-by=<its Waits on: the keys you made for the entries it names,
   and any keys it gives>`.

Then `agent.mjs submit <key> "<the design, and each entry's number with its
key>" --filed=<every key you made>`: the work item is Done, keeps
`{{l.taskBreakdown}}`, and its comment lists them. Change no entry's scope, acceptance
or design. An entry you can't file as written (a section missing, a contract
it names that isn't there, a check that isn't the spec's) stops the job before
you create anything: comment on the work item what is missing, entry by entry,
then `agent.mjs needs-human <key> "<the entries, and what each lacks>"`. The
owner sends the "Technical design" work item back to the architect, and the
merge of the fixed design moves yours back to Todo.

**`{{l.design}}`** asks for the breakdown and the design. Clone
{{design}} beside your checkout, read its `README.md` and
`AGENTS.md`, and open one PR there (`{{l.pr}}` is not for it: the owner
reviews and merges design PRs) that adds `features/<slug>/spec.md` from
`features/_template/` with `status: Draft` in its frontmatter and its wireframes,
`wireframes/NN-<screen>.html`, at the sizes the README gives. Render each
wireframe to PNG (`npx -y playwright screenshot --viewport-size "1440, 900"
--full-page file://$PWD/<file>.html <file>.png`, or 390 × 844 for a phone
frame) and attach the PNGs to the work item (`agent.mjs attach <key>
<file.png>…`), so the owner can review in Linear. The rewritten description
points at the spec by path and at the PR. Neither the spec nor the PR has open
questions: decide what has a likely right answer and record it under the spec's
"Decisions". One that is really the owner's ({{design.name}}'s `AGENTS.md`,
"Questions for the owner") is asked before the PR opens, with
`agent.mjs needs-human <key> "<question>"`, which moves the item to {{state.needsHuman}},
and the tick moves on.

**Done:** `agent.mjs submit <key> "<summary>"` comments the summary (what
changed, the slices, and the design PR),
takes off `{{l.taskBreakdown}}` or `{{l.design}}`, and your lock. With
`--replaced-by` the item is Canceled as well, and with `--filed` it is Done and
keeps its label (above). A breakdown that isn't finished when the tick ends stays locked until
`finish`, keeps its label, and the next pm tick carries it on from the
comments and the PR.

## Architect ticks

An architect tick writes a feature's technical design; it builds nothing. Its
prompt says "run your **architect tick** as `<name>`" (with the tool:
`AGENT_ROLE=architect`). It has a name and label of its own
(`{{l.agent}}claude-architect-1`) and takes one job at a time: the work item
it already holds, else the next one the owner labelled `{{l.techDesign}}`
that is in Backlog or Todo, nobody holds, and is not `{{l.handsOff}}`, in a
pm tick's order. It reviews, fixes and merges nothing, and takes no other
job. While an item carries the label
no tick builds it, and no pm tick takes it.

The label stays on when the design is written; the work item's state says how
far it is. Linear moves it to In Progress when the design's pull request opens,
and `agent.mjs submit` to {{state.qa}}, so no architect tick takes it again. It is
Done when the owner merges that pull request: Linear moves it, not the tick. To
send a design back, the owner moves the work item to Todo.

What it reads, what the technical design holds, and how it hands the work on
are in [`ARCHITECT.md`](ARCHITECT.md), which only an architect tick needs to
read. It files no work items: once the owner merges its design, {{design.name}}'s
hand-off workflow files "Task breakdown: <slug>", labelled `{{l.taskBreakdown}}`, and a
pm tick files the design's proposed issue sequence ("PM ticks", "A merged technical design").
[`LIFECYCLE.md`](LIFECYCLE.md) is the whole path a feature takes, from
the idea to QA, and who checks what along it.

## What you may take

- `{{l.needs}}<thing>` on a work item (in Linear `needs-<thing>` in the
  `{{g.protocol}}` group) means the work can't be checked without it:
  `{{l.needs}}ios-sim` (a simulator), `{{l.needs}}design` (read access to {{design.name}}).
  Take it only if your sandbox has that.
- Nothing else holds a work item back. Which agent takes it doesn't matter:
  every session starts from the same work item, spec and code. Several agents
  may hold items with the same `area/*` label at once; the label says what
  part of the product an item is in. If two PRs touch the same lines, the second to merge
  gets `{{conflict}}` and its author merges `{{base}}` in (step 1).
- Sessions that share one name share one label, so they can't tell each
  other's locks apart. Give every scheduled task or coordinator that should
  work on its own a name of its own; sessions that do share a name tick one
  after another, not at once.

## What watches the agents

A scheduled job runs `sweep.mjs` for a home repository, every 10 minutes or so
(README.md, "Running the housekeeping").
{{note:sweep-jobs}}
Each sweeps only its own repository's work items and pull requests. It removes a lapsed claim and settles a doubled one, keeps
`{{l.blocked}}` on the open work items that have an open blocker, moves
work items with their pull requests (In Progress from Todo, never Backlog, with
a link while one is open, {{state.qa}} or Done once one that closes them merges, or
once the last sub-issue of a split item is done), and it keeps the **Agent desk**
work item in Linear current with whatever is overdue: a ready work item in focus
no agent has taken, a PR without a review, a failing PR its author left, a PR
reviewed `ok` with auto-merge still off, one held with `{{l.hold}}` for a day, anything
waiting on a person (a work item in {{state.needsHuman}}, a PR labelled `{{l.needsHuman}}`;
with the work items it holds up, those in focus marked), work waiting in {{state.qa}}, work waiting for a
pm or architect tick, an agent that stopped ticking. A pm
tick's lock on a Backlog item is expected; any other tick's is listed.

Another job runs `reviewed.mjs` every 2 minutes or so and posts the `{{status}}`
status ("Merging") on every open PR's head. A PR whose newest head has no
`{{status}}` status after a few minutes means that job is failing, not that the
review is missing: say so in your heartbeat.

`page.mjs` sends the page for `{{l.needsHuman}}` on a PR, where it is set up.
Where it isn't, the label reaches the owner through the desk's "Needs you"
list alone. Use it as this file says all the same.
{{note:paging}}
