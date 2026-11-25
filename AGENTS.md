# Agents working on swarm

This repository holds the protocol ([`PROTOCOL.md`](PROTOCOL.md)) and the tools
every agent's tick runs. It is not one of the repositories a tick works in.

A change here changes what guards a merge in every repository that uses it, so
a pull request that loosens a rule (what counts as a review, when auto-merge
goes on, what the sweep lets lapse) takes `swarm/needs-human` unless the owner
asked for it (PROTOCOL.md, "The exceptions").

`PROTOCOL.md`, `TICK.md` and `ARCHITECT.md` are rendered: don't edit them.
Change the template in `templates/` (or a note in `notes/`, or
`swarm.config.json`), run `npm run docs`, and commit the template and the
rendered file together; `npm test` fails while they differ. A name or number
that is a setting is written `{{…}}` in a template, never spelt out
(`lib/render.mjs` lists them, README.md, "Settings").

The `.mjs` scripts at the top are run by path from other repositories, the
chart's CronJobs and old clones of this one (which hand off to origin/main's
`agent.mjs`), so they stay where they are. Shared code goes in `lib/`, tests in
`test/`.

Run `npm test` before you push; it needs nothing installed. The tests run
under settings of their own (`test/fixtures/swarm.config.json`), so a change to
`swarm.config.json` changes what the swarm does without changing what they
expect; only the test that the documents are current reads the real one.
