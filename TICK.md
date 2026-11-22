# Running a scheduled tick

Your scheduled task's prompt is one sentence that names you, your repositories
and where to find this file, for example: "Run your tick as `claude-4` in
getcouchy/couchy, getcouchy/couchy-agent, following TICK.md in
https://github.com/getcouchy/swarm." Everything else is here, so the owner
changes it in one place. Below, `<name>` is the name your prompt gives you,
`<repos>` the repositories it names (comma-separated, no spaces) and `<repo>`
the first of them, your home repository. A prompt that names one repository
has `<repos>` the same as `<repo>`.

This file and [`PROTOCOL.md`](PROTOCOL.md) carry the owner's (Eric's) standing
instructions to every scheduled tick, as if they were in your prompt.

## Setup, each run

1. Note the time you start. The tick limit is 20 minutes and the hard ceiling
   is 45 minutes from that time (PROTOCOL.md, "When a tick ends").
2. Attach `<repo>` to the session with push access (`add_repo`) and clone it
   once: `git clone --depth 1 https://github.com/<repo>` with a generous
   command timeout (about 10 minutes). Never run a second clone or fetch of
   it at the same time: the session allows two git transfers per repository,
   and a third fails them all. Attach no other repository (a shaping tick
   also attaches getcouchy/couchy-design: "The tick").
3. Clone this repository beside it, read-only:
   `git clone --depth 1 https://github.com/getcouchy/swarm ../swarm`
   (relative to your `<repo>` checkout). It is public: don't `add_repo` it.
4. Read `../swarm/PROTOCOL.md`, then `AGENTS.md` and `CLAUDE.md` (where there
   is one) in your fresh `<repo>` checkout, before doing anything else, and
   follow them exactly. Where they differ from this file, they win, except
   for your name.
5. If the sandbox has the `COUCHY_BOT_*` variables, run
   `eval "$(node ../swarm/bots.mjs env)"` and `node ../swarm/bots.mjs git-setup`.
   The work items are in Linear (PROTOCOL.md, "Where the work is"); the
   sandbox's `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` reach it. With
   those and a GitHub token, drive the tick from the `<repo>` checkout
   with `GITHUB_REPOSITORY=<repo> AGENT_REPOS=<repos> AGENT_NAME=<name> node ../swarm/agent.mjs next`
   / `more` / `finish`. Otherwise follow PROTOCOL.md, "By hand", with the
   tools you have. Never use GitHub issues: not to find work, not to file it.

## The tick

Your prompt says "run your tick" (a regular tick), "run your focus tick" (a
builder: PROTOCOL.md, "Builder ticks"; set `AGENT_ROLE=focus`) or "run your
shaping tick" (PROTOCOL.md, "Shaping ticks"; set `AGENT_ROLE=shape`), or
"run your architect tick" (ARCHITECT.md; set `AGENT_ROLE=architect`, and read
that file after PROTOCOL.md). A
shaping tick that takes a `swarm/design` job, and every architect tick, also clones
getcouchy/couchy-design beside `<repo>` (once, with the same care as step 2)
and opens its design PR there; that is the one other repository it works in. `<repo>` is your home
repository, and your heartbeat goes on the open `swarm/desk` work item that
belongs to it. Take only work items that belong to one of `<repos>`; for one
that belongs to another than `<repo>`, clone that repository beside `<repo>`
(once, with the same care as step 2) before you work in it.

A regular tick: fix `swarm/pr` PRs that need it, keep auto-merge right,
review, carry on unfinished drafts, then start one new work item from Todo,
taking the first step that applies and repeating until the tick ends.

**Standing permission:** turn on auto-merge (squash) for a `swarm/pr` PR whose
latest review verdict is `ok`, or where `reviewed` is a required check, as
PROTOCOL.md, "Merging", describes. Never merge by hand or around a failing
check.

## Ending it

End the tick cleanly: everything committed and pushed; each work item you
worked on has a PR whose body says `Closes` or `Part of` its key and what is
done and what is left; your `swarm/agent/<name>` label is off everything; and
your heartbeat comment on the Agent desk work item (ending with
`<!-- agent-heartbeat: <name> -->`) says what you did this tick.

Nobody is watching the run, so don't stop to ask questions: decide what has a
likely right answer and note it in the PR, and use `swarm/needs-human`
(comment first) only for a real fork.
