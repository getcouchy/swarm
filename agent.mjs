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
//   node ../swarm/agent.mjs more --started=<ISO time> [--wrote=12,15]
//                                                after any job: the next one, while the tick has time left;
//                                                --wrote lists the PRs this session wrote, which it won't review
//   node ../swarm/agent.mjs finish           the end of the tick: take my lock off everything
//   node ../swarm/agent.mjs claim 123        lock one issue or PR by number
//   node ../swarm/agent.mjs release 123 "why"   unlock it, with a comment
//
// A tick covers every repository in AGENT_REPOS (default: GITHUB_REPOSITORY and
// getcouchy/couchy-agent), and each job names its `repo`. For a number in
// another repository than the first, write it with the repository:
// `claim getcouchy/couchy-agent#12`, `--wrote=12,getcouchy/couchy-agent#15`.
//
// AGENT_NAME is this agent's name (codex, grok, claude-2…), which makes its
// label swarm/agent/<name>; AGENT_CAN lists what its sandbox has, matching
// swarm/needs/* labels ("ios-sim,design"); // AGENT_ROLE=focus runs a builder tick (PROTOCOL.md, "Builder ticks").
// Needs GITHUB_TOKEN and GITHUB_REPOSITORY (default getcouchy/couchy).

import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reposFromEnv } from './github.mjs';
import { syncHere, toolsFromMain } from './preflight.mjs';
import { isValidProvider } from './rules.mjs';
import { claim, firstJob, heartbeat, mayContinue, nextAcross, release, releaseAll } from './tick.mjs';

const [cmd, ...args] = process.argv.slice(2);
const me = process.env.AGENT_NAME || process.env.AGENT_PROVIDER; // the old variable still works
if (!isValidProvider(me)) {
  console.error('Set AGENT_NAME to your name: lower-case letters, digits and hyphens (codex, grok, claude-2).');
  process.exit(2);
}
const id = me;
const can = new Set((process.env.AGENT_CAN ?? '').split(',').map((s) => s.trim()).filter(Boolean));
// AGENT_ROLE=focus makes this a builder tick: its own PRs and issues in focus, nothing else.
const role = process.env.AGENT_ROLE === 'focus' ? 'focus' : 'all';
const ceiling = Number(process.env.AGENT_TICK_CEILING || 45);
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

const clients = reposFromEnv();
const gh = clients[0]; // the home repository: the Agent desk and its heartbeats live there
// "12" is in the home repository; "getcouchy/couchy-agent#12" names its own.
const ref = (text) => {
  const m = /^(?:([\w.-]+\/[\w.-]+)#)?(\d+)$/.exec(text ?? '');
  const client = m && clients.find((c) => c.repo === (m[1] ?? gh.repo));
  if (!client) {
    console.error(`${cmd} needs an issue number, or owner/name#number for one of: ${clients.map((c) => c.repo).join(', ')}.`);
    process.exit(2);
  }
  return { client, number: Number(m[2]) };
};

let out;
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
if (cmd === 'next') {
  // A failed heartbeat must not cost the tick.
  await heartbeat(gh, id).catch((e) => console.error(`heartbeat: ${e.message}`));
  out = await firstJob(clients, checkout, { me, can, role, doClaim: !args.includes('--look') });
  // One job doesn't end the tick; say when it began so `more` can budget it.
  if (out.job !== 'none' && out.job !== 'checkout') Object.assign(out, { minutesToCeiling: ceiling, then: `node ${entry} more --started=${new Date().toISOString()}` });
} else if (cmd === 'more') {
  // After any job: the next one, unless this tick's time is spent. It only
  // looks: the agent claims an issue itself once it judges that it fits.
  const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const wrote = new Map();
  for (const text of (opt('wrote') ?? '').split(',').filter(Boolean)) {
    const { client, number } = ref(text);
    wrote.set(client.repo, (wrote.get(client.repo) ?? new Set()).add(number));
  }
  const room = mayContinue({ startedAt: opt('started'), minutes: Number(process.env.AGENT_TICK_MINUTES || 20), ceiling });
  // The job before this one is finished and pushed, so its lock comes off:
  // the label says someone is on the work now, and nobody is.
  const released = [];
  for (const c of clients) released.push(...(await releaseAll(c, me).catch(() => [])).map((n) => `${c.repo}#${n}`));
  out = room.ok ? await nextAcross(clients, { me, can, role, wrote, doClaim: false }) : { job: 'none', why: room.why };
  if (released.length) out.released = released;
  if (out.job !== 'none') {
    Object.assign(out, {
      minutesToCeiling: room.left,
      fit: `Start this only if you judge it will be done, pushed and its PR updated within minutesToCeiling; otherwise end the tick.${out.lock ? ` If you start it, run claim ${out.repo === gh.repo ? '' : `${out.repo}#`}${out.lock} first.` : ''}`,
      then: `node ${entry} more --started=${opt('started')}${opt('wrote') ? ` --wrote=${opt('wrote')}` : ''}`,
    });
  }
} else if (cmd === 'finish') {
  // The end of a tick: every lock of mine comes off, whatever state the work is in.
  const released = [];
  for (const c of clients) released.push(...(await releaseAll(c, me)).map((n) => `${c.repo}#${n}`));
  out = { finished: true, released };
} else if (cmd === 'claim') {
  const { client, number } = ref(args[0]);
  out = { repo: client.repo, issue: number, claimed: await claim(client, number, me) };
} else if (cmd === 'release') {
  const { client, number } = ref(args[0]);
  await release(client, number, me, args.slice(1).join(' '));
  out = { repo: client.repo, issue: number, released: true };
} else {
  console.error('Usage: agent.mjs next [--look] | more --started=<ISO time> [--wrote=<PR numbers>] | finish | claim <issue or PR> | release <issue or PR> [reason]');
  process.exit(2);
}
console.log(JSON.stringify(out, null, 2));
if (out.claimed === false) process.exit(1);
