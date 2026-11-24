#!/usr/bin/env node
// An agent's side of the multi-provider protocol (see PROTOCOL.md).
// Run it from the checkout you work in, with this repository cloned beside it:
//
//   node ../swarm/agent.mjs next             what to do now, as JSON; claims the issue it hands out.
//                                                First it fast-forwards a clean main to origin/main and, if
//                                                that moved, starts again on the new code. A checkout that is
//                                                dirty, on another branch, or ahead of origin is left alone
//                                                and is itself the job (`checkout`): nothing is claimed or
//                                                offered until it is dealt with. AGENT_NO_SYNC=1 skips this.
//
// Whatever the command, if this clone of the tools differs from origin/main's
// (an old clone, or the branch of a swarm PR), origin/main's copy is run
// instead, from a temporary directory.
//   node ../swarm/agent.mjs next --look      the same, without claiming
//   node ../swarm/agent.mjs more --started=<ISO time> [--wrote=12,15] [--skip=COUCHYUX-12,57]
//                                                after any job: the next one, while the tick has time left;
//                                                --wrote lists the PRs this session wrote, which it won't review;
//                                                --skip, the work items and PRs it passed over, not to offer again
//   node ../swarm/agent.mjs finish           the end of the tick: take my lock off everything
//   node ../swarm/agent.mjs claim COUCHYUX-12   lock one work item (by key) or PR (by number)
//   node ../swarm/agent.mjs release COUCHYUX-12 "why"   unlock it, with a comment
//   node ../swarm/agent.mjs needs-human COUCHYUX-12 "question"
//                                                hand it to a person: the comment, then swarm/needs-human
//   node ../swarm/agent.mjs hold 57 "what it waits for"
//                                                hold a PR's merge: the comment, then swarm/hold
//   node ../swarm/agent.mjs show COUCHYUX-12      a work item as Markdown, with its comments and attachments
//   node ../swarm/agent.mjs images COUCHYUX-12    download its description's images and its attachments to read
// A task-breakdown tick also has describe, create, blocked-by, labels, attach and
// submit (breakdown.mjs; PROTOCOL.md, "Task-breakdown ticks").
//
// Work items are in the tracker (workitems.mjs) and pull requests on GitHub (github.mjs).
// A tick covers every repository in AGENT_REPOS (default: GITHUB_REPOSITORY and
// getcouchy/couchy-agent), and each job names its `repo`. For a PR in another
// repository than the first, write it with the repository:
// `claim getcouchy/couchy-agent#12`, `--wrote=12,getcouchy/couchy-agent#15`.
//
// AGENT_NAME is this agent's name (codex, grok, claude-2…), which makes its
// label swarm/agent/<name>; AGENT_CAN lists what its sandbox has, matching
// swarm/needs/* labels ("ios-sim,design"); AGENT_ROLE=focus runs a builder tick
// (PROTOCOL.md, "Builder ticks"), AGENT_ROLE=task-breakdown a task-breakdown tick ("Task-breakdown ticks"),
// AGENT_ROLE=architect an architect tick (ARCHITECT.md).
// AGENT_TICK_MINUTES (20) and AGENT_TICK_CEILING (45) are the tick's limit and
// ceiling, in minutes (PROTOCOL.md, "When a tick ends").
// Needs GITHUB_TOKEN and GITHUB_REPOSITORY (default getcouchy/couchy), and
// the work item tracker's credentials (Linear's: linear.mjs).
// TICK_EVENTS_FILE, when set, gets one JSON line per command that ran: the
// job, the queue it came from, the locks taken and released, the handoff, the
// GitHub requests left (commands.mjs).

import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, UsageError, writeEvent } from './lib/commands.mjs';
import { reposFromEnv } from './lib/github.mjs';
import { providerFromEnv, tracker } from './lib/workitems.mjs';
import { syncHere, toolsCommit, toolsFromMain } from './lib/preflight.mjs';
import { isValidProvider } from './lib/rules.mjs';
import { timeCommand } from './lib/timing.mjs';

const [cmd, ...args] = process.argv.slice(2);
const me = process.env.AGENT_NAME || process.env.AGENT_PROVIDER; // the old variable still works
if (!isValidProvider(me)) {
  console.error('Set AGENT_NAME to your name: lower-case letters, digits and hyphens (codex, grok, claude-2).');
  process.exit(2);
}
// Before anything that reaches the network: the fetch below can hang too.
timeCommand(process.env.TICK_EVENTS_FILE, cmd);
const can = new Set((process.env.AGENT_CAN ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const asked = process.env.AGENT_ROLE === 'shape' ? 'task-breakdown' : process.env.AGENT_ROLE; // the old role still works
const role = ['focus', 'task-breakdown', 'architect'].includes(asked) ? asked : 'all';
const ceiling = Number(process.env.AGENT_TICK_CEILING) || 45;
// How the agent ran this script, for the `then` commands it prints; a copy run
// from origin/main is handed the original's path.
const entry = process.env.SWARM_ENTRY || relative(process.cwd(), fileURLToPath(import.meta.url));
// Every command runs origin/main's tools, whatever branch this checkout is on:
// a PR branch carries the tools from when it was cut, and those may read the
// labels by rules that have since changed. AGENT_NO_SYNC=1 turns this off.
if (!process.env.AGENT_NO_SYNC && !process.env.AGENT_TOOLS_FROM_MAIN) {
  let current = null;
  try {
    current = toolsFromMain();
  } catch (e) {
    console.error(`tools: ${e.message.split('\n')[0]}`); // not a git checkout, or no network: carry on with these
  }
  if (current) {
    console.error("tools: this clone of getcouchy/swarm differs from origin/main's; running origin/main's. To run local edits to the tools, set AGENT_NO_SYNC=1.");
    const again = spawnSync(process.execPath, [current, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, AGENT_TOOLS_FROM_MAIN: '1', SWARM_ENTRY: entry } });
    process.exit(again.status ?? 1);
  }
}

const clients = await Promise.all(reposFromEnv().map(async (gh) => tracker(gh, await providerFromEnv(gh.repo))));

let checkout = null;
if (cmd === 'next' && !process.env.AGENT_NO_SYNC) {
  try {
    checkout = syncHere();
  } catch (e) {
    console.error(`preflight: ${e.message.split('\n')[0]}`); // not a git checkout, or no network: carry on
  }
  if (checkout?.state === 'updated') {
    // The rules and this tool just changed under us: run the new copy.
    console.error(`preflight: main ${checkout.from} -> ${checkout.to}; starting again on the new code. Re-read the repository's AGENTS.md if it changed.`);
    const again = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, AGENT_NO_SYNC: '1' } });
    process.exit(again.status ?? 1);
  }
}
let result;
try {
  result = await run(cmd, args, { clients, me, can, role, ceiling, minutes: Number(process.env.AGENT_TICK_MINUTES) || 20, entry, checkout, swarm: toolsCommit() });
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(e.message);
  process.exit(2);
}
const { out, event } = result;
console.log(JSON.stringify(out, null, 2));
await writeEvent(process.env.TICK_EVENTS_FILE, event);
if (out.claimed === false || out.labelled === false) process.exit(1);
