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
import { fromEnv } from './lib/github.mjs';
import { pushRun } from './lib/metrics.mjs';
import { REVIEWED, checkToWaitFor, isReviewable, reviewedStatus } from './lib/rules.mjs';

/**
 * Posts the status for one PR unless its head already carries the same one. Returns { line, state }:
 * the line to log and the status's state.
 * `creator` (REVIEWED_CREATOR, e.g. `getcouchy-swarm[bot]`) counts only that account's statuses as
 * already there: a ruleset that requires `reviewed` from one app ignores the same status from another,
 * so one GitHub Actions left behind must not stop this app writing its own.
 */
export async function status(gh, pr, { creator = process.env.REVIEWED_CREATOR || '' } = {}) {
  let want = reviewedStatus(pr, await gh.reviews(pr.number));
  if (want.state === 'success' && isReviewable(pr)) {
    const required = await gh.requiredChecks(pr.base?.ref);
    const wait = required.length ? checkToWaitFor(required, await gh.allChecks(pr.head.sha)) : null;
    if (wait) want = { state: 'pending', description: `Reviewed ok. ${wait}` };
  }
  // Statuses come newest first; GitHub keeps at most 1000 per commit and context, so don't repeat one.
  const have = (await gh.statuses(pr.head.sha)).find((s) => s.context === REVIEWED && (!creator || s.creator?.login === creator));
  const line = `#${pr.number}: ${want.state} (${want.description})`;
  if (have?.state === want.state && have.description === want.description) return { line: `${line}, unchanged`, state: want.state };
  await gh.setStatus(pr.head.sha, { ...want, context: REVIEWED, target_url: pr.html_url });
  return { line, state: want.state };
}

/**
 * status() for every open one of `pulls`. One that can't be worked out gets no
 * status and is named in `failed`; the rest get theirs, so one unreadable
 * author never holds up every merge.
 */
export async function reportAll(gh, pulls, { log = console.log, error = console.error, ...opts } = {}) {
  const posted = [];
  const failed = [];
  for (const pr of pulls.filter((p) => p.state === 'open')) {
    try {
      const { line, state } = await status(gh, pr, opts);
      log(line);
      posted.push({ number: pr.number, state });
    } catch (e) {
      error(`#${pr.number}: ${e.message}`);
      failed.push(pr.number);
    }
  }
  return { posted, failed };
}

/** status(), for callers that want only the line to log. */
export const report = async (gh, pr, opts) => (await status(gh, pr, opts)).line;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const startedAt = Date.now();
  const gh = fromEnv();
  const number = Number(process.argv[2] || process.env.PR_NUMBER);
  const pulls = number ? [await gh.pull(number)] : await gh.openPulls();
  const { posted, failed } = await reportAll(gh, pulls);
  if (failed.length) process.exitCode = 1; // the job shows as failed, with every other status posted
  // The statuses are all posted before a metric is touched: nothing about the
  // metrics may keep a pull request from its status. A push replaces everything
  // this job pushed before, so a run for one pull request doesn't push: it
  // would drop every other one's series.
  const fill = (reg) => {
    for (const p of posted) reg.set('swarm_reviewed_pulls', { number: String(p.number), state: p.state }, 1);
    reg.set('swarm_job_last_success_timestamp_seconds', {}, Date.now() / 1000);
    reg.set('swarm_job_duration_seconds', {}, (Date.now() - startedAt) / 1000);
    if (gh.rateLimitRemaining() !== null) reg.set('swarm_github_rate_limit_remaining', {}, gh.rateLimitRemaining());
  };
  // Nor does a run with a failure: the last success it pushed before stays, and ages.
  if (!number && !failed.length && await pushRun({ fill, job: 'swarm_reviewed', repository: gh.repo })) console.log('Pushed metrics.');
}
