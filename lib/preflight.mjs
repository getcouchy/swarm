// Before a tick chooses work: bring this checkout's main up to origin's, so
// the tick runs the current protocol and tools, not the ones from the last
// time this machine pulled. Only a clean checkout on main, or a clean detached one
// (a fresh worktree of origin/main), is moved, and only forward. Anything else is somebody's work in progress: it is reported,
// with the pull request or held issue it most likely belongs to, and left alone.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_PREFIX, BASE_BRANCH, isSwarmPull, linkedTo, providers, refText } from './rules.mjs';

const run = (cwd) => (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * git: (...args) => stdout, throwing on a non-zero exit.
 * Returns { state: 'current' | 'updated' | 'left', branch, ... }:
 *   updated: { from, to }  main moved forward; re-read the repository's AGENTS.md and re-run the tool
 *   left:    { dirty: [paths], behind, ahead?, why }  nothing was changed
 */
export function sync(git, { main = BASE_BRANCH, remote = 'origin' } = {}) {
  const head = git('rev-parse', '--abbrev-ref', 'HEAD');
  // A fresh worktree of origin/main (`git worktree add <path> origin/main`) has
  // a detached HEAD. It is as good a place to tick from as main itself.
  const detached = head === 'HEAD';
  const branch = detached ? '(detached)' : head;
  // Untracked files don't count: a lock file or an editor's swap file is not
  // work in progress, and a fast-forward leaves them where they are.
  const dirty = git('status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean).map((l) => l.replace(/^\s*\S+\s+/, '')); // " M path"
  git('fetch', '--quiet', remote, main); // safe anywhere: it moves no branch of ours
  const behind = Number(git('rev-list', '--count', `HEAD..${remote}/${main}`));
  if ((!detached && head !== main) || dirty.length) {
    return { state: 'left', branch, dirty, behind, why: dirty.length ? 'uncommitted changes' : `on ${branch}, not ${main}` };
  }
  // Commits origin doesn't have are unpublished work too, however clean the tree looks.
  const ahead = Number(git('rev-list', '--count', `${remote}/${main}..HEAD`));
  const where = detached ? 'this detached checkout' : main;
  if (ahead && !behind) return { state: 'left', branch, dirty, behind, ahead, why: `${where} has ${ahead} commit${ahead > 1 ? 's' : ''} that ${remote}/${main} lacks` };
  if (!behind) return { state: 'current', branch };
  if (ahead) return { state: 'left', branch, dirty, behind, ahead, why: `${where} has commits ${remote}/${main} lacks, so it can't fast-forward` };
  const from = git('rev-parse', '--short', 'HEAD');
  try {
    if (detached) git('checkout', '--quiet', '--detach', `${remote}/${main}`);
    else git('merge', '--ff-only', `${remote}/${main}`);
  } catch {
    // An untracked file in the way of one origin added, for one.
    return { state: 'left', branch, dirty, behind, why: `could not move to ${remote}/${main}; git refused` };
  }
  return { state: 'updated', branch, from, to: git('rev-parse', '--short', 'HEAD') };
}

/**
 * What a checkout that was left alone most likely holds, so the agent finishes
 * it instead of pulling over it: the open PR for its branch, else a work item
 * this agent holds that has no PR yet. pulls, issues: as from workitems.mjs's tracker().
 */
export function likelyWork({ branch, dirty }, { me, pulls = [], issues = [], linked = new Map() }) {
  const pr = pulls.find((p) => p.head?.ref === branch);
  if (pr) {
    const on = providers(pr).filter((p) => p !== me);
    if (isSwarmPull(pr) && !on.length) {
      // The swarm's work is anyone's to carry on while nobody else is on it.
      return { pull: pr.number, title: pr.title, advice: `This is the branch of open PR #${pr.number}, and no other agent is on it. Lock it (claim ${pr.number}), commit and push what is finished, say in the PR what is left, then start the tick from a clean main.` };
    }
    const whose = on.length ? `${AGENT_PREFIX}${on[0]} is working on now` : "is a person's (it has no swarm label)";
    return {
      pull: pr.number,
      title: pr.title,
      owner: on[0] ?? null,
      advice: `This is the branch of open PR #${pr.number}, which ${whose}. Leave it exactly as it is: commit nothing, push nothing. Say so in your heartbeat and run this tick from a fresh worktree of origin/main (git worktree add).`,
    };
  }
  const held = issues.filter((i) => providers(i).includes(me) && !linkedTo(linked, i).length);
  if (held.length) {
    return {
      issues: held.map((i) => i.number),
      advice: `You hold ${held.map((i) => refText(i.number)).join(', ')} with no PR yet, and this is probably that work. Read the diff; if it is, push it as a draft PR for the work item before anything else.`,
    };
  }
  return {
    advice: dirty.length
      ? 'No open PR or held issue explains these changes. Do not discard them: say so in your heartbeat, and run this tick from a fresh worktree of origin/main (git worktree add).'
      : 'No open PR uses this branch. If it has commits origin lacks, push them on a branch of their own (never to main); then start again from a clean main at origin/main.',
  };
}

export const syncHere = (cwd = process.cwd()) => sync(run(cwd));

/**
 * The tools live in their own repository, cloned beside the
 * work. Whether this copy of them differs from origin/main's: it does when the
 * clone is old, or when it is on a branch of a swarm PR. Old tools read the
 * labels by old rules (after the labels moved under swarm/, a copy from before
 * the move saw another agent's issue as free), so a tick's commands must never
 * run from them.
 */
export const toolsDir = dirname(fileURLToPath(import.meta.url));

export function toolsStale(git, { main = 'main', remote = 'origin' } = {}) {
  git('fetch', '--quiet', remote, main);
  try {
    git('diff', '--quiet', 'HEAD', `${remote}/${main}`);
    return false;
  } catch {
    return true; // git diff --quiet exits 1 when they differ
  }
}

/** The commit these tools are, twelve digits: a copy's is its directory's name (toolsFromMain). null when it can't be told. */
export function toolsCommit(dir = toolsDir) {
  const copy = /swarm-tools-([0-9a-f]{12})(?:\/|$)/.exec(dir)?.[1];
  if (copy) return copy;
  try {
    return run(dir)('rev-parse', '--short=12', 'HEAD');
  } catch {
    return null; // not a git checkout
  }
}

/**
 * A copy of origin/main's tools in a temporary directory, when this
 * copy is stale; null when it is current. The clone itself is not touched.
 * Returns the path of the copy's agent.mjs.
 */
export function toolsFromMain(cwd = toolsDir, { main = 'main', remote = 'origin' } = {}) {
  if (!toolsStale(run(cwd), { main, remote })) return null;
  const top = run(cwd)('rev-parse', '--show-toplevel');
  // One copy per commit of origin/main, reused by every command of the tick.
  const dir = join(tmpdir(), `swarm-tools-${run(cwd)('rev-parse', '--short=12', `${remote}/${main}`)}`);
  const script = join(dir, 'agent.mjs');
  if (existsSync(script)) return script;
  // Extract beside it and rename into place, so a half-written copy is never run.
  const part = mkdtempSync(join(tmpdir(), 'swarm-tools-part-'));
  const archive = spawnSync('git', ['archive', `${remote}/${main}`], { cwd: top, maxBuffer: 64 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive: ${archive.stderr}`);
  const untar = spawnSync('tar', ['-x', '-C', part], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`tar: ${untar.stderr}`);
  try {
    renameSync(part, dir);
  } catch (e) {
    rmSync(part, { recursive: true, force: true });
    if (!existsSync(script)) throw e; // another command of this tick got there first: use its copy
  }
  // Copies for earlier commits of main are no use to anyone.
  for (const name of readdirSync(tmpdir())) {
    if (/^swarm-tools-[0-9a-f]{12}$/.test(name) && join(tmpdir(), name) !== dir) rmSync(join(tmpdir(), name), { recursive: true, force: true });
  }
  return script;
}
