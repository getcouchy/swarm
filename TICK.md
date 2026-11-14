# Running a scheduled tick

Your scheduled task's prompt is one sentence that names you, your repository
and where to find this file, for example: "Run your tick as `claude-4` in
getcouchy/couchy-agent, following TICK.md in https://github.com/getcouchy/swarm."
Everything else is here, so the owner changes it in one place. Below, `<name>`
is the name your prompt gives you and `<repo>` the repository it names.

This file and [`PROTOCOL.md`](PROTOCOL.md) carry the owner's (Eric's) standing
instructions to every scheduled tick, as if they were in your prompt.

## Setup, each run

1. Note the time you start. The tick limit is 20 minutes and the hard ceiling
   is 45 minutes from that time (PROTOCOL.md, "When a tick ends").
2. Attach `<repo>` to the session with push access (`add_repo`) and clone it
   once: `git clone --depth 1 https://github.com/<repo>` with a generous
   command timeout (about 10 minutes). Never run a second clone or fetch of
   it at the same time: the session allows two git transfers per repository,
   and a third fails them all. Attach no other repository.
3. Clone this repository beside it, read-only:
   `git clone --depth 1 https://github.com/getcouchy/swarm ../swarm`
   (relative to your `<repo>` checkout). It is public: don't `add_repo` it.
4. Read `../swarm/PROTOCOL.md`, then `AGENTS.md` and `CLAUDE.md` (where there
   is one) in your fresh `<repo>` checkout, before doing anything else, and
   follow them exactly. Where they differ from this file, they win, except
   for your name.
5. If the sandbox has the `COUCHY_BOT_*` variables, run
   `eval "$(node ../swarm/bots.mjs env)"` and `node ../swarm/bots.mjs git-setup`.
   If a GitHub token is available, drive the tick from the `<repo>` checkout
   with `GITHUB_REPOSITORY=<repo> AGENT_REPOS=<repo> AGENT_NAME=<name> node ../swarm/agent.mjs next`
   / `more` / `finish`. Otherwise follow PROTOCOL.md, "By hand", with the
   GitHub tools you have.

## The tick

Your prompt says "run your tick" (a regular tick) or "run your focus tick" (a
builder: PROTOCOL.md, "Builder ticks"). Work in `<repo>` only: it is your home
repository, and your heartbeat goes on its open `swarm/desk` issue. You can't
reach the other repositories, so an issue blocked by one of their issues
counts as blocked; pass it by.

A regular tick: fix `swarm/pr` PRs that need it, keep auto-merge right,
review, carry on unfinished drafts, then start one new approved issue, taking
the first step that applies and repeating until the tick ends.

**Standing permission:** turn on auto-merge (squash) for a `swarm/pr` PR whose
latest review verdict is `ok`, or where `reviewed` is a required check, as
PROTOCOL.md, "Merging", describes. Never merge by hand or around a failing
check.

## Ending it

End the tick cleanly: everything committed and pushed; each issue you worked
on has a PR whose body says what is done and what is left; your
`swarm/agent/<name>` label is off everything; and your heartbeat comment on
`<repo>`'s `swarm/desk` issue (ending with `<!-- agent-heartbeat: <name> -->`)
says what you did this tick.

Nobody is watching the run, so don't stop to ask questions: decide what has a
likely right answer and note it in the PR, and use `swarm/needs-human`
(comment first) only for a real fork.
