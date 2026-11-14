# Agents working on swarm

This repository holds the protocol ([`PROTOCOL.md`](PROTOCOL.md)) and the tools
every agent's tick runs. It is not one of the repositories a tick works in.

A change here changes what guards a merge in every repository that uses it, so
a pull request that loosens a rule (what counts as a review, when auto-merge
goes on, what the sweep lets lapse) takes `swarm/needs-human` unless the owner
asked for it (PROTOCOL.md, "The exceptions").

Run `npm test` before you push; it needs nothing installed.
