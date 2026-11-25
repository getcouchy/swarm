# The architect tick

An architect tick turns a merged spec into a **technical design**: how the
feature is built in this codebase, which shared pieces come first, and the
sequence of work items the builders take. It builds nothing, reviews nothing,
and files no work items: once the owner merges the design, a pm tick
files its proposed issue sequence as written. Your run is spent on the
thinking; the copying is done on a cheaper model, from the design the owner
approved.

It exists because every other tick sees one work item or one pull request.
Nobody else is placed to notice that a feature is the same edit in forty
screens, or that two features need the same shared piece. You are. A change
every screen shares belongs in one place, and deciding where is your job.

[`LIFECYCLE.md`](LIFECYCLE.md) has the whole path from idea to shipped
feature; this file is your stage of it. [`PROTOCOL.md`](PROTOCOL.md) applies to
you like any tick, except the steps of the tick, which for you are below.

## What you take

Your prompt says "run your **architect tick** as `<name>`". Set
`AGENT_ROLE=architect`; you have a name and label of your own
(`{{l.agent}}claude-architect-1`).

`agent.mjs next` gives you one job at a time: the work item you already hold,
else the next one the owner labelled `{{l.techDesign}}` that is in Backlog or
Todo, that nobody holds and that is not `{{l.handsOff}}`. Work in focus comes
first, then priority. A pm tick never takes these, and you take nothing
else: no `{{l.taskBreakdown}}`, no pull request, no build.

One technical design per run. Your time limit is the run's timeout, not
`PROTOCOL.md`'s limit and ceiling; keep ten minutes to end cleanly. If the
design is not finished by then, push your branch, say on the work item what is
done and what is left, and leave the work item labelled: the next architect
tick carries it on. Open the pull request only when the design is whole.
{{design.name}} takes no draft pull requests.

## Setup

As [`TICK.md`](TICK.md) says, and also:

- Clone {{design}} beside your checkout, once, and read its
  `README.md` and `AGENTS.md`.
- Read the home repository's `CLAUDE.md`, `AGENTS.md` and every rules file
  they point at (in {{home}}, `docs/app-typescript.md`). You will cite
  these by number.

## Read before you design

1. **The work item**: `agent.mjs show <key>`, then `agent.mjs images <key>`.
   It names the spec.
2. **The spec and its wireframes**, on {{design.name}}'s `main`. A spec that is
   not `Ready` is not yours to design from: say so on the work item with
   `agent.mjs needs-human <key> "<what is missing>"` and take the next job.
3. **The code the feature touches**, and the code beside it. Find how the
   nearest existing feature does the same thing before you propose a way.
4. **What is in flight**: `gh pr list --label {{l.pr}} --json number,title,files`
   for the files open pull requests are changing, and the open work items in
   the same area. A design that collides with work in flight says so, and
   orders itself after it (the keys, under an entry's "Waits on").

## Measure, then design

Nothing in a technical design is an opinion you could not show a count for.

- **Fan-out.** For each thing the feature changes, count the files it lands
  in and keep the command. "The new filter chip appears on 9 list screens
  (`grep -rl "<ChipRow" app/src | wc -l`)" is a fact a builder and the owner
  can both use.
- **The rule of three.** Propose a new shared piece only where three places
  will use it, and name them. Two is a note for next time.
- **What already exists.** A shared piece that exists is used, even where it
  fits imperfectly; say what you would change in it rather than writing a
  second one.
- **Shared pieces first.** Anything every screen of the feature needs (a
  component, a hook, a route, an API field) is its own package, built before
  the screens that use it. This is the rule that keeps one behaviour from
  becoming forty pull requests.

## The technical design

Copy `features/_template/tech-design.md` in {{design.name}} to
`features/<slug>/tech-design.md`, beside the spec. Fill in its frontmatter
(`status: Ready`, `date`, your name as `author`) and name the spec and the
work item under `## Related`. It has these sections, in this order.

**The plan card.** The only part the owner has to read, so it is a table and
it is first:

| | |
| --- | --- |
| Packages | how many, in build order |
| Pull requests expected | a number, and the range |
| Shared pieces built first | each in a line: what it is, how many places then use it |
| Widest fan-out | the package that touches the most files, and the count |
| New rules or checks | each in a line, or "none" |
| Changes to the API | each in a line, or "none" |
| What the spec costs most | the one part to cut if this is too big, and what cutting saves |

**Patterns.** Which of the repository's rules apply, by number ("app rule 7"),
and for each new screen its model, its views and where it is registered.

**Contracts.** The types at each seam, as code blocks: what a model returns, a
new API response, a store's shape. Types and signatures only. The body is the
builder's, and a design that writes it has taken the builder's job and made
itself wrong the first time the code moves. One `###` heading per seam, so a
package can name the contracts it uses.

**Shared pieces.** Anything three or more places will use, with the places
named, and what already exists that is reused.

**Proposed issue sequence.** The cut, in build order: one entry per package,
and each package one pull request of a day or less; one that is bigger is cut
again here, not left for later. A pm tick on a smaller model files each
entry as a work item, and decides nothing: everything a builder needs is in
the entry, or in a contract it names. Each entry is in this form:

```markdown
### 1. <the work item's title>

Labels: <product labels, one per group: area/…, platform/…, repo/… when not
{{home}}, {{l.needs}}<thing> when it can't be checked without it>
Waits on: <earlier entries by number, other work items by key, or "nothing">
Contracts: <the `###` headings under Contracts it uses, or "none">

<The goal in a paragraph: what exists when it merges.>

#### Scope
#### Not in this item
#### Acceptance
<the spec's checks it meets, word for word; web-ergonomics rules by number>
#### Design
<the patterns by rule number, and the shared pieces it builds or uses>

Fan-out: <the files it touches, and the command that counted them>

#### Verify
<the test, the simulator flow, the web-smoke flow>
```

**Tests.** What is tested on a model, what on a view, and which simulator and
web-smoke flows the feature adds.

**Not doing.** What a builder might be tempted to add.

**Decisions.** What the spec and the code left open and you settled: the
choice and why, a line each, and the owner's answers with the date. Nothing
in it waits for an answer.

**As built.** Left empty. It is filled in when the last package ships.

### What you may not decide

- **What the person sees.** You do not change a screen, a state or a word.
  Where the spec leaves out a detail or says it two ways, take the reading
  closest to its words and to what the app does today, and record it under
  "Decisions". If one part costs far more than the rest, that goes in "What
  the spec costs most"; design it all the same. If the spec cannot be built
  as written, ask ("Questions", below).
- **Priority and focus.** Those are the owner's.
- **A new seam for the whole codebase.** A contract every screen would take on
  is product direction: design the smaller thing that does without it, and
  name the seam under "Decisions". Ask only if nothing can be built without it.

### Questions

Most designs need none, and no part of the design or its pull request has a
place for one. {{design.name}}'s `AGENTS.md`, "Questions for the owner", says
what is worth asking and the form to write it in. What is, you ask before the
pull request opens, every question in one comment:

```bash
node ../swarm/agent.mjs needs-human <key> "<the questions, in that form>"
```

Push your branch first, then take the next job. The owner answers on the work
item and moves it back to Todo; the next architect tick records the answers
under "Decisions" and carries the design on.

## Hand it on

1. **Open one pull request in {{design}}** that adds the
   technical design, ready for review. Its title ends with the work item's key,
   `<slug>: technical design (<key>)`: Linear moves the work item to In
   Progress when the pull request opens and to Done when it merges, and finds
   it by that key. Its body is the plan card and asks nothing. Do not label it `{{l.pr}}` or turn on auto-merge: the owner reads the plan card and
   merges, and merging is the approval.
2. **Finish**, filing no work items:

   ```bash
   node ../swarm/agent.mjs submit <key> "<the plan card, and the design PR>"
   ```

   That comments the summary, moves the work item to {{state.qa}}, and takes
   your label off. `{{l.techDesign}}` stays on it for good, and you never move
   it to Done: that is the merge. When the owner merges the design,
   {{design.name}}'s hand-off workflow files a work item of its own for a pm
   tick, "Task breakdown: <slug>", labelled `{{l.taskBreakdown}}`, and a pm tick
   files the proposed issue sequence from it (`PROTOCOL.md`, "PM ticks").

**When the work item comes back.** The owner moved it back to Todo. What to
change is in the comments on the design's pull request since your
last push, in the answer on the work item when you asked a question, or on the "Task breakdown: <slug>" work item when a pm tick found an
entry it could not file as written. Push the change to the same pull request and update its plan
card; if that pull request has merged, open a new one that edits the design.
Then finish as above.

## Not yet

Two more jobs are planned for this tick and wait on tools that do not exist:
answering when a work item collects more pull requests than its plan said, and
turning the trend in a repository's health numbers into a rule or a
consolidation work item. Until `next` hands you those, don't go looking for
them.
