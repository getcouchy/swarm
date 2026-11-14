#!/usr/bin/env node
// Posts the `reviewed` commit status on pull request heads (see PROTOCOL.md,
// "Merging", and docs/ci.md, "Reviewed check"): success once the latest
// review verdict is `ok`, failure on `changes`, pending while nobody has
// given one or while `swarm/needs-human` or `swarm/hold` is on the PR. It gates
// the agents' PRs and people's PRs marked `swarm/review-only`. Made a
// required check on main, it is what lets auto-merge go on when a PR opens.
//
//   node ../swarm/reviewed.mjs          every open pull request
//   node ../swarm/reviewed.mjs 123      one
//
// Needs GITHUB_TOKEN (statuses write, pull requests read) and GITHUB_REPOSITORY;
// REVIEWED_CREATOR is optional (see status). A run over every pull request
// ends by pushing each one's status as a Prometheus metric (docs/metrics.md)
// when SWARM_PUSHGATEWAY_URL is set.

import { pathToFileURL } from 'node:url';
import { fromEnv } from './github.mjs';
import { push, registry } from './metrics.mjs';
import { REVIEWED, reviewedStatus } from './rules.mjs';

/**
 * Posts the status for one PR unless its head already carries the same one. Returns { line, state }:
 * the line to log and the status's state.
 * `creator` (REVIEWED_CREATOR, e.g. `getcouchy-swarm[bot]`) counts only that account's statuses as
 * already there: a ruleset that requires `reviewed` from one app ignores the same status from another,
 * so one GitHub Actions left behind must not stop this app writing its own.
 */
export async function status(gh, pr, { creator = process.env.REVIEWED_CREATOR || '' } = {}) {
  const want = reviewedStatus(pr, await gh.reviews(pr.number));
  // Statuses come newest first; GitHub keeps at most 1000 per commit and context, so don't repeat one.
  const have = (await gh.statuses(pr.head.sha)).find((s) => s.context === REVIEWED && (!creator || s.creator?.login === creator));
  const line = `#${pr.number}: ${want.state} (${want.description})`;
  if (have?.state === want.state && have.description === want.description) return { line: `${line}, unchanged`, state: want.state };
  await gh.setStatus(pr.head.sha, { ...want, context: REVIEWED, target_url: pr.html_url });
  return { line, state: want.state };
}

/** status(), for callers that want only the line to log. */
export const report = async (gh, pr, opts) => (await status(gh, pr, opts)).line;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const startedAt = Date.now();
  const gh = fromEnv();
  const number = Number(process.argv[2] || process.env.PR_NUMBER);
  const pulls = number ? [await gh.pull(number)] : await gh.openPulls();
  const reg = registry();
  for (const pr of pulls.filter((p) => p.state === 'open')) {
    const { line, state } = await status(gh, pr);
    console.log(line);
    reg.set('swarm_reviewed_pulls', { number: String(pr.number), state }, 1);
  }
  // A push replaces everything this job pushed before, so a run for one pull
  // request doesn't push: it would drop every other one's series.
  if (!number) {
    reg.set('swarm_job_last_success_timestamp_seconds', {}, Date.now() / 1000);
    reg.set('swarm_job_duration_seconds', {}, (Date.now() - startedAt) / 1000);
    if (gh.rateLimitRemaining() !== null) reg.set('swarm_github_rate_limit_remaining', {}, gh.rateLimitRemaining());
    if (await push(reg, { job: 'swarm_reviewed', repository: gh.repo })) console.log('Pushed metrics.');
  }
}
