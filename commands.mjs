// What each agent.mjs command does, given one plane.mjs tracker() per
// repository (tests pass fakes), and the line it adds to TICK_EVENTS_FILE.
// agent.mjs reads the environment and the checkout, then runs one of these.

import { appendFileSync } from 'node:fs';
import { isKey } from './plane.mjs';
import { HOLD, NEEDS_HUMAN } from './rules.mjs';
import { claim, firstJob, heartbeat, mayContinue, nextAcross, release, releaseAll } from './tick.mjs';

export const USAGE = 'Usage: agent.mjs next [--look] | more --started=<ISO time> [--wrote=<PR numbers>] | finish | claim <work item or PR> | release <work item or PR> [reason] | needs-human <work item or PR> "<question>" | hold <PR> "<what it waits for>"';

/** A command line agent.mjs can't run: it prints the message and exits 2. */
export class UsageError extends Error {}

const WORK = ['fix', 'hold', 'merge', 'review', 'implement'];
// A work item goes out under its sequence number with its key beside it, so a
// line's repo, number and type still name one thing.
const item = (repo, ref, type) => (isKey(ref) ? { repo, number: Number(ref.split('-').pop()), type: 'issue', key: ref } : { repo, number: ref, type });
// A job's item is its lock, else its pull, else its issue; a pull when that number is the job's pull.
const jobItem = (job) => {
  const number = job.lock ?? job.pull ?? job.issue;
  return item(job.repo, number, number === job.pull ? 'pull' : 'issue');
};
// What a next or more line says about the job it offered.
const offered = (out) => ({
  job: out.job,
  ...(WORK.includes(out.job) ? jobItem(out) : {}),
  ...(out.job === 'none' ? { why: out.why, skipped: (out.repos ?? []).flatMap((r) => (r.skipped ?? []).map((s) => ({ repo: r.repo, ...s }))) } : {}),
});
const typeOf = async (client, ref) => (isKey(ref) || !(await client.issue(ref)).pull_request ? 'issue' : 'pull');
/** The fewest GitHub requests any of the clients has left, or null before any response. */
const rateLimit = (clients) => {
  const left = clients.map((c) => c.rateLimitRemaining?.()).filter((n) => n != null);
  return left.length ? Math.min(...left) : null;
};

/**
 * Run one command. ctx: { clients (the home repository's first), me, can,
 * role, ceiling, minutes, entry (how the agent ran agent.mjs), checkout (what
 * the preflight found, for next) }. Returns { out, event }: `out` is what the
 * command prints, and event() builds its TICK_EVENTS_FILE line, so nothing
 * extra is asked of GitHub unless that file is set; null for a handoff that
 * failed.
 */
export async function run(cmd, args, { clients, me, can, role, ceiling, minutes, entry, checkout = null }) {
  const gh = clients[0]; // the home repository: the Agent desk and its heartbeats live there
  // "COUCHYUX-12" is a work item; "57" a pull request in the home repository,
  // "getcouchy/couchy-agent#57" one in its own.
  const ref = (text) => {
    if (isKey(text)) {
      const project = text.split('-')[0];
      return { client: clients.find((c) => c.plane?.project === project) ?? gh, number: text };
    }
    const m = /^(?:([\w.-]+\/[\w.-]+)#)?(\d+)$/.exec(text ?? '');
    const client = m && clients.find((c) => c.repo === (m[1] ?? gh.repo));
    if (!client) throw new UsageError(`${cmd} needs a work item's key (COUCHYUX-12), a PR number, or owner/name#number for one of: ${clients.map((c) => c.repo).join(', ')}.`);
    return { client, number: Number(m[2]) };
  };
  const done = (out, fields) => ({ out, event: async () => {
    const line = await fields();
    return { v: 1, at: new Date().toISOString(), cmd, ...line, rateLimitRemaining: rateLimit(clients) };
  } });
  const releaseMine = async (soft) => {
    const released = [];
    for (const c of clients) {
      const items = await (soft ? releaseAll(c, me).catch(() => []) : releaseAll(c, me));
      released.push(...items.map((i) => item(c.repo, i.number, i.type)));
    }
    return released;
  };
  const named = (items) => items.map((i) => i.key ?? `${i.repo}#${i.number}`);

  if (cmd === 'next') {
    // A failed heartbeat must not cost the tick.
    await heartbeat(gh, me).catch((e) => console.error(`heartbeat: ${e.message}`));
    const claimed = [];
    const out = await firstJob(clients, checkout, { me, can, role, doClaim: !args.includes('--look'), onClaim: (repo, job) => claimed.push(jobItem({ ...job, repo })) });
    // One job doesn't end the tick; say when it began so `more` can budget it.
    if (out.job !== 'none' && out.job !== 'checkout') Object.assign(out, { minutesToCeiling: ceiling, then: `node ${entry} more --started=${new Date().toISOString()}` });
    return done(out, () => ({ ...offered(out), claimed }));
  }
  if (cmd === 'more') {
    // After any job: the next one, unless this tick's time is spent. It only
    // looks: the agent claims an issue itself once it judges that it fits.
    const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
    const wrote = new Map();
    for (const text of (opt('wrote') ?? '').split(',').filter(Boolean)) {
      const { client, number } = ref(text);
      wrote.set(client.repo, (wrote.get(client.repo) ?? new Set()).add(number));
    }
    const room = mayContinue({ startedAt: opt('started'), minutes, ceiling });
    // The job before this one is finished and pushed, so its lock comes off:
    // the label says someone is on the work now, and nobody is.
    const released = await releaseMine(true);
    const out = room.ok ? await nextAcross(clients, { me, can, role, wrote, doClaim: false }) : { job: 'none', why: room.why };
    if (released.length) out.released = named(released);
    if (out.job !== 'none') {
      Object.assign(out, {
        minutesToCeiling: room.left,
        fit: `Start this only if you judge it will be done, pushed and its PR updated within minutesToCeiling; otherwise end the tick.${out.lock ? ` If you start it, run claim ${out.repo === gh.repo ? '' : `${out.repo}#`}${out.lock} first.` : ''}`,
        then: `node ${entry} more --started=${opt('started')}${opt('wrote') ? ` --wrote=${opt('wrote')}` : ''}`,
      });
    }
    return done(out, () => ({ ...offered(out), released }));
  }
  if (cmd === 'finish') {
    // The end of a tick: every lock of mine comes off, whatever state the work is in.
    const released = await releaseMine(false);
    return done({ finished: true, released: named(released) }, () => ({ released }));
  }
  if (cmd === 'claim') {
    const { client, number } = ref(args[0]);
    const won = await claim(client, number, me);
    return done({ repo: client.repo, issue: number, claimed: won }, async () => {
      const it = item(client.repo, number, await typeOf(client, number));
      return { ...it, claimed: won ? [it] : [], ...(won ? {} : { lost: true }) };
    });
  }
  if (cmd === 'release') {
    const { client, number } = ref(args[0]);
    await release(client, number, me, args.slice(1).join(' '));
    return done({ repo: client.repo, issue: number, released: true }, async () => {
      const it = item(client.repo, number, await typeOf(client, number));
      return { ...it, released: [it] };
    });
  }
  if (cmd === 'needs-human' || cmd === 'hold') {
    // A handoff: the comment first, then the label, which pages the owner
    // (needs-human) with the latest comment as its text.
    const { client, number } = ref(args[0]);
    const text = args.slice(1).join(' ').trim();
    if (!text) throw new UsageError(`Usage: agent.mjs ${cmd} <${cmd === 'hold' ? 'PR' : 'work item or PR'}> "<${cmd === 'hold' ? 'what it waits for' : 'question'}>"`);
    const label = cmd === 'hold' ? HOLD : NEEDS_HUMAN;
    const out = { repo: client.repo, issue: number, label, commented: false, labelled: false };
    try {
      await client.comment(number, `${text}\n\n<!-- agent: ${me} -->`);
      out.commented = true;
      await client.addLabel(number, label);
      out.labelled = true;
    } catch (e) {
      out.error = e.message;
    }
    // Not handed off until the label is on: no line for the runner to count.
    if (!out.labelled) return { out, event: null };
    return done(out, async () => item(client.repo, number, await typeOf(client, number)));
  }
  throw new UsageError(USAGE);
}

/**
 * Append a command's line to `file` (TICK_EVENTS_FILE), when it is set. A
 * failure is one line on stderr and never the command's.
 */
export async function writeEvent(file, event) {
  if (!file || !event) return;
  try {
    appendFileSync(file, `${JSON.stringify(await event())}\n`);
  } catch (e) {
    console.error(`events: ${e.message}`);
  }
}
