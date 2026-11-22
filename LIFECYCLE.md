# From an idea to a shipped feature

This doc describes the whole path a feature takes, who acts at each stage, what they hand on, and
who checks it. [`PROTOCOL.md`](PROTOCOL.md) stays the rule for a tick; this
file is the stages around it.

Parts marked **(new)** do not exist yet. Everything else is how the work runs
today, or is in the tools: the architect's first job, the technical design, is
([`ARCHITECT.md`](ARCHITECT.md)). The last section lists what has to be built
for the new parts to be true.

## The path

```
 owner + design agent        architect            shaper         builders, reviewers        owner
┌──────────┐  ┌────────┐  ┌──────────────┐  ┌────────────┐  ┌───────────┐  ┌──────────────┐  ┌────┐
│ 1 Riff   │→ │ 2 Spec │→ │ 3 Technical  │→ │ 4 Packages │→ │ 5 Shape   │→ │ 6 Build      │→ │ 8  │
│          │  │        │  │   design     │  │            │  │           │  │ 7 Review,    │  │ QA │
└──────────┘  └────────┘  └──────────────┘  └────────────┘  └───────────┘  │   merge      │  └────┘
   go / smaller  spec PR     design PR with     Linear          work items  └──────────────┘
   / no          merged      plan card merged   project         in Todo        PRs merged
                 (owner)     (owner)                                       9 Watch: sweep, architect, audit
```

The owner acts at four points: the riff, merging the spec, merging the plan
card, and QA. Nothing else waits on the owner unless an agent hits a real fork
(`PROTOCOL.md`, "When to call a person").

## The roles

| Role | Decides | Never | Reads | Writes |
| --- | --- | --- | --- | --- |
| **Owner** | Whether to build it, what it is for, the plan's size, whether it shipped right, real forks | Reviews code or picks a pattern | The spec, the plan card, the weekly digest | Merges, QA comments, answers |
| **Design agent** | What the person sees and does: screens, states, wording, on the phone and at desk width | Says how to build it | couchy-design, the design system, the live app | `spec.md`, wireframes |
| **Architect** | How it is built: which patterns, what is shared, the order, the cut into packages | Changes what the person sees; reviews routine PRs; sets priority | The spec, the code, the repository's rules, every stream in flight | `tech-design.md` and its proposed issue sequence; later, rules and their lint checks **(new)** |
| **Shaper** | How a merged design's issue sequence, and work that did not come through the architect, become work items an agent can build without asking | Redesigns; builds | The work item, the spec, the technical design | Work items (`PROTOCOL.md`, "Shaping ticks") |
| **Builder** | Everything inside one work item | Redesigns: a wrong design goes back to the architect | The work item, the repository's rules | Pull requests |
| **Reviewer** | `ok` or `changes` on one pull request | Reviews a PR it wrote in the same session | The PR, its work item, the rules, the item's other PRs **(new)** | A verdict |
| **CI and the sweep** | Nothing: they check what is written down | | | Statuses, the desk, metrics |
| **Auditor** **(new)** | What the numbers miss | Changes code | The whole codebase, with no brief from the architect | A report, read by the owner |

One agent can hold more than one role on different ticks, but never two on the
same piece of work: the design agent does not write its feature's technical
design, and the architect's design is reviewed by another agent.

## The stages

### 1. Riff: is this worth building?

- **Who:** the owner and the design agent, in conversation.
- **In:** an idea, in the owner's words.
- **The design agent's job is to test the idea, not to agree with it.** Before
  it draws anything it says, in this order:
  1. what the person is trying to do, in one sentence, and whether Couchy
     already does it some other way (`__agents/features-index.md` in couchy-design, the live app);
  2. the strongest case against building it: who it confuses, what it makes
     harder, what it costs to carry;
  3. the smallest version that would tell us if it is wanted;
  4. whether the idea is one feature or several stuck together;
  5. its verdict: build it, build the smaller one, or don't build it, and why.

  It draws mockups only after the owner has answered the case against. It keeps
  disagreeing while it has a reason: the owner deciding otherwise settles the
  question, the owner repeating the idea does not.
- **Out:** mockups, revised until both agree. Nothing durable yet.
- **Gate:** the owner says "write the spec", or the two agree not to build it.

### 2. Spec: what the person sees and does

- **Who:** the design agent.
- **Artifact:** `features/<slug>/spec.md` and `wireframes/` in
  getcouchy/couchy-design, on a PR (its `README.md` has the conventions).
- **It holds:** the problem, the case against and the owner's answer
  **(new)**, the proposal screen by screen, behaviour and every word on the
  screen, "What a still cannot show" for desk width, the design system pieces,
  what is out of scope, open questions with a recommended answer each, and
  **acceptance: checks a person can walk**, written so they can be copied word
  for word into work items.
- **It does not hold how to build it.** No file to change, no helper to
  write, no count of call sites. The template's "Implementation notes"
  becomes "Notes for the architect" **(new)**: what the design agent noticed
  in the code, as observations the architect may ignore.
- **Gate:** the owner reads it and merges the PR. Merging sets the spec to
  `Ready` and is the approval (couchy-design, "Merging is approval").
- **Hand-off:** one work item in the feature's Linear project, "Technical
  design: <feature>", naming the spec by path and labelled
  `swarm/tech-design`. The design agent files it when the spec merges, or the
  owner does. That label is what the architect's tick looks for.

### 3. Technical design: how it is built

- **Who:** an architect tick ([`ARCHITECT.md`](ARCHITECT.md)), with the spec
  and the codebase open.
- **Artifact:** `features/<slug>/tech-design.md`, beside the spec, on its own
  PR in getcouchy/couchy-design.
- **It opens with the plan card**, the only part the owner has to read:

  | | |
  | --- | --- |
  | Packages | how many, in build order |
  | Pull requests expected | a number, and the range |
  | Shared pieces built first | each in a line: what it is, how many screens then use it |
  | Widest fan-out | the package that touches the most files, and the count |
  | New rules or checks | each in a line, or "none" |
  | Changes to the API | each in a line, or "none" |
  | What the spec costs most | the one part to cut if this is too big, and what cutting saves |
  | Questions for the owner | real forks only, each with a recommended answer |

- **Then, for the agents:**
  - **Patterns.** Which of the repository's rules apply, by number
    (`docs/app-typescript.md` in getcouchy/couchy: "app rule 7"), and for each
    new screen its model, its views and its entry in the page table.
  - **Contracts.** The types at each seam, as code blocks: a model's return
    type, a new API response, a new store's shape. Types and signatures only;
    the body is the builder's.
  - **Shared pieces.** Anything three or more screens will use is its own
    package, built first (app rule 0).
  - **Proposed issue sequence.** The cut into packages, in order, each
    written as the work item it becomes: title, labels, what it waits on,
    the contracts it uses, Scope, Not in this item, Acceptance (the spec's
    checks, word for word), Design, Fan-out (and the command that counted
    it), Verify. Written so a shaper on a smaller model files it without
    deciding anything.
  - **Tests.** What is tested on the model, what on a view, which simulator
    and web-smoke flows.
  - **Not doing.** What a builder might be tempted to add.
- **The architect pushes back on cost** the way the design agent pushes back
  on the idea: "this state costs 12 pull requests; without it, 3" goes in
  "What the spec costs most". It does not change the spec. A spec it cannot
  build as written goes back to stage 2 as a question.
- **Gate:** the owner reads the plan card and merges the design's PR. The
  owner approves the size and the order, not the code. Before that, another
  agent reviews the design against the repository's rules **(new)**.

### 4. Packages: the work, in Linear

- **Who:** a shaping tick (`PROTOCOL.md`, "Shaping ticks", "A merged
  technical design"), once the owner merges the design: the merge labels its
  work item `swarm/needs-shaping` (couchy-design's
  `tech-design-handoff.yml`). Not the architect: its run, on the strongest
  model, is spent on the design, and the work items are filed from the
  design the owner approved, so a change asked for on the PR leaves none to
  cancel.
- **Artifact:** one work item per entry of the proposed issue sequence, in
  Backlog, in the feature's project, with Linear's "blocked by" set from each
  entry's "Waits on". The shaper copies; it changes no scope, acceptance or
  design. Each contract an entry names is pasted in full: a builder's sandbox
  may not reach couchy-design, so nothing is left as a link. The "Technical
  design" work item closes in their favour.
- **Gate:** the owner moves the packages to Todo after merging the design.
  That is the approval for work, as it is today.

### 5. Shape: for work that did not come through the architect

- **Who:** a shaping tick (`PROTOCOL.md`, "Shaping ticks").
- **When:** a bug, a one-screen change, or a work item filed by hand that the
  owner labels `swarm/needs-shaping`. A feature's packages arrive shaped from
  stage 4 and skip this.
- **Artifact:** the work item rewritten as Scope, Not in this item,
  Acceptance, Verify, and two sections more **(new)**: `### Design` (the
  repository's rules that apply, by number) and `Fan-out:` (the files it
  touches, and the command). A shaper that finds the same edit landing in
  more than three files stops and asks for a technical design.
- **Gate:** the owner moves it to Todo.

### 6. Build

- **Who:** builder ticks, one work item each (`PROTOCOL.md`, "Your tick").
- **Artifact:** pull requests that say `Closes` or `Part of` the work item,
  with the What's new entry, the simulator flow and the web-smoke flow the
  repository's `CLAUDE.md` asks for, and "Decisions made" in the body.
- **A builder follows the design section.** If it is wrong or missing
  something, the builder does not improvise a different structure: it pauses
  the work item with the question (`swarm/needs-shaping`, and a comment), and
  the architect answers **(new)**.

### 7. Review and merge

- **Who:** a reviewer tick, CI, then GitHub's auto-merge.
- **The reviewer checks** the work item's acceptance, then the repository's
  rules: a rule the diff newly breaks is `changes`, cited by number **(new)**.
  Its job tells it how many pull requests the work item already has **(new)**,
  so it can see the same edit arriving again.
- **CI checks** types, lint, tests, the simulator and web-smoke, and that no
  suppression or budget count went up **(new)**.
- **Gate:** `reviewed`, `check` and `simulator` green; auto-merge does the rest.

### 8. QA

- **Who:** the owner, when a work item reaches the QA state.
- **What:** walk the acceptance checks in the deployed build. Pass moves it
  to Done. A fail goes back to Todo with a comment naming the check that
  failed; the fix is a new PR for that check only.

### 9. Watch

- **The sweep**, every 10 minutes: locks, overdue work, and **(new)** a work
  item with more pull requests than its plan said, which it stops offering
  and lists on the desk.
- **The architect**, once a day **(new)**: the stopped work items first (what
  shared piece would make the rest one pull request?), then the trend in the
  suppression counts and the health numbers. A trend becomes a rule with its
  check, a consolidation work item, or nothing. It cites the number that made
  it act.
- **When a project's last package ships**, the architect adds "As built" to
  the technical design: what differed from the plan, in a few lines, and the
  pull request count against the estimate.
- **The weekly digest** **(new)**, for the owner: the health numbers with
  their direction, the rules added, each project's pull requests against its
  estimate, and at most three questions with recommended answers.
- **The audit**, monthly **(new)**: an agent from another provider reads the
  codebase with no brief from the architect and reports what the numbers miss.

## Who checks what

| What could be wrong | Caught by | When |
| --- | --- | --- |
| The idea is not worth building | Design agent's case against; the owner | 1 |
| The design does not fit the product, or is two features | Design agent; the owner reading the spec | 1, 2 |
| The spec decides how to build it | Architect, who sends it back | 3 |
| The plan is the same edit in many places | Architect (fan-out per package); the owner (pull requests expected) | 3 |
| The technical design breaks the repository's rules | The agent that reviews it | 3 |
| A package's work item does not stand on its own | The builder, who sends it back | 6 |
| The code breaks a rule lint knows | CI | 7 |
| The code breaks a rule lint does not know | Reviewer | 7 |
| The plan was wrong and the work is fanning out | The sweep's count, then the architect | 9 |
| It does not do what the spec said | The owner's QA | 8 |
| A smell nobody has named yet | The audit | 9 |
| The architect is wrong | The agent that reviews its designs and rule changes; the audit; pull requests against its own estimates in the digest | 3, 9 |

## Going back

| From | To | When | How |
| --- | --- | --- | --- |
| Architect | Design agent and owner | The spec cannot be built as written, or one part costs far more than the rest | A question on the spec's PR or work item, with options and what each costs |
| Shaper | Architect | An entry of the issue sequence can't be filed as written | A comment on the design's work item, and Needs Human; the owner puts `swarm/tech-design` back |
| Builder | Architect | The design section is wrong | Pause the work item with the question |
| Sweep | Architect | A work item passes its expected pull request count | The stop, and a line on the desk |
| Owner (QA) | Builder | A check fails | Back to Todo with a comment |
| Audit | Architect and owner | A new kind of smell | The report; the architect turns what the owner accepts into rules |

Nothing goes back by an agent quietly doing another role's job. A builder that
redesigns, a shaper that changes scope, or an architect that changes a screen
has skipped the check that role exists for.

## What the owner reads, and when

| When | What | About how long |
| --- | --- | --- |
| Per feature | The riff | As long as it is useful |
| Per feature | The spec, then merge | What it takes today |
| Per feature | The plan card, then merge and move the packages to Todo | A few minutes: a table and at most three questions |
| Per work item in QA | Walk the acceptance checks | What it takes today |
| Weekly | The digest | About ten minutes |
| Monthly | The audit's summary | About ten minutes |
| Any time | A real fork | One answer |

The owner can read more: the contracts in a technical design are type
signatures, close to reading Go interfaces. Nothing waits on that.

## What has to be built

In the order that makes each stage true:

1. The spec template: "Case against", "Acceptance", and "Notes for the
   architect" in place of "Implementation notes" (couchy-design).
2. The design agent's brief: stage 1's five points, as its standing prompt.
3. `tech-design.md` in the feature template, with the plan card (couchy-design).
4. The architect's other two jobs: a stopped work item, and the daily trend.
   Its first, the technical design, is built (`AGENT_ROLE=architect`,
   `swarm/tech-design`, `ARCHITECT.md`); it needs a tick scheduled for it.
5. The tools it needs: the pull requests of each work item, the files open
   pull requests share, the suppression and budget counts with their trend.
6. The shaping template's `### Design` and `Fan-out:`, and `shaped` refusing
   a description without them.
7. The reviewer's rule check and the work item's pull request count in its job.
8. The stop when a work item passes its expected count.
9. The ratchet check in each repository's CI.
10. The digest and the audit, as scheduled tasks.

An architect's run can also be started by hand, for one feature: a session
given `ARCHITECT.md` and the work item's key.

## Decisions still open

- **Who moves a feature's packages to Todo.** The owner, as today. If that
  becomes the wait, the architect could do it once the design's PR is merged.
- **How far over its estimate a work item may go before it stops.** This draft
  says twice the plan's number.
- **Whether a small change skips stages 3 to 5.** A bug fix or a one-screen
  change probably goes straight to a work item; the line is not drawn here.
- **Which agent reviews the architect.** Another provider's is the stronger
  check; any other session is the minimum.
