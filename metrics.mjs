// The swarm's Prometheus metrics (docs/metrics.md): their definitions, a
// registry that holds one run's samples, the text format, and the push to a
// Pushgateway. A CronJob run is over before Prometheus could scrape it, so
// sweep.mjs and reviewed.mjs push at the end of a run instead. A push replaces
// everything the same job pushed for the repository before, so a series for
// an item that is no longer open goes away with the next run.
//
// SWARM_PUSHGATEWAY_URL turns it on. No dependencies.

const gauge = (help, labels = []) => ({ type: 'gauge', help, labels });
const counter = (help, labels = []) => ({ type: 'counter', help, labels });

// `repository` and `job` are not listed: the push's grouping key supplies
// both, and the Pushgateway refuses a series that carries its own `job`.
export const METRICS = {
  swarm_agent_last_tick_timestamp_seconds: gauge('When the agent last edited its heartbeat comment on the Agent desk.', ['agent']),
  swarm_pulls: gauge('1 for each open pull request the agents work on or review, by its state.', ['number', 'state', 'agent']),
  swarm_issues: gauge('1 for each approved open issue that an agent holds (locked) or could take (claimable).', ['number', 'state', 'agent']),
  swarm_lock_age_seconds: gauge("How long an agent's lock label has been on the issue or pull request.", ['number', 'agent', 'type']),
  swarm_overdue_age_seconds: gauge('How long an item on the Agent desk has been in the condition that put it there.', ['number', 'kind', 'agent']),
  swarm_limit_seconds: gauge('The limits the sweep ran with.', ['limit']),
  swarm_sweep_fixed: gauge('What the last sweep fixed by itself.', ['action']),
  swarm_needs_human_total: counter('Times swarm/needs-human went onto an issue or pull request.', ['type', 'agent']),
  swarm_hold_total: counter('Times swarm/hold went onto a pull request.', ['agent']),
  swarm_reviewed_pulls: gauge('1 for each open pull request, by the `reviewed` status of its head.', ['number', 'state']),
  swarm_job_last_success_timestamp_seconds: gauge('When the job last ran to its end.'),
  swarm_job_duration_seconds: gauge("How long the job's last run took."),
  swarm_github_rate_limit_remaining: gauge("GitHub API requests left in the token's hour after the job's last run."),
};

const escapeValue = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** One run's samples. `set` takes only the metrics and labels METRICS defines. */
export function registry() {
  const samples = new Map(); // metric name -> Map(rendered labels -> value)
  return {
    set(name, labels, value) {
      const def = METRICS[name];
      if (!def) throw new Error(`${name} is not a metric in metrics.mjs`);
      const unknown = Object.keys(labels ?? {}).filter((k) => !def.labels.includes(k));
      if (unknown.length) throw new Error(`${name} has no label ${unknown.join(', ')}`);
      const rendered = def.labels.map((k) => `${k}="${escapeValue(labels[k] ?? '')}"`).join(',');
      if (!samples.has(name)) samples.set(name, new Map());
      samples.get(name).set(rendered, Number(value));
    },
    render() {
      const out = [];
      for (const [name, rows] of samples) {
        out.push(`# HELP ${name} ${METRICS[name].help}`, `# TYPE ${name} ${METRICS[name].type}`);
        for (const [labels, value] of rows) out.push(`${name}${labels ? `{${labels}}` : ''} ${value}`);
      }
      return out.length ? `${out.join('\n')}\n` : '';
    },
  };
}

/**
 * Replaces what `job` last pushed for `repository` with the registry's
 * samples. Returns whether it was pushed. A Pushgateway that is down, slow or
 * refusing costs one logged line: the run's own work is done by then and must
 * not fail over its metrics.
 */
export async function push(reg, {
  job, repository, url = process.env.SWARM_PUSHGATEWAY_URL, dryRun = process.env.DRY_RUN === 'true',
  fetchImpl = fetch, log = console.error, timeoutMs = 5000,
}) {
  if (!url || dryRun) return false;
  // The repository holds a slash, which a path segment can't; the Pushgateway reads `@base64` values.
  const target = `${url.replace(/\/+$/, '')}/metrics/job/${encodeURIComponent(job)}/repository@base64/${Buffer.from(repository).toString('base64url')}`;
  // A timer of its own: AbortSignal.timeout's doesn't keep the process alive while it waits.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs);
  try {
    const res = await fetchImpl(target, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; version=0.0.4' },
      body: reg.render(),
      signal: abort.signal,
    });
    if (res.ok) return true;
    log(`metrics: the Pushgateway answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  } catch (e) {
    log(`metrics: could not push to the Pushgateway: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  return false;
}

/**
 * What a script calls at the end of a run: `fill(registry)` sets the run's
 * samples, and they are pushed as push() does. Nothing here throws. A sample
 * that METRICS doesn't allow costs a logged line, as a Pushgateway that is
 * down does, and the run's own work stands.
 */
export async function pushRun({ fill, log = console.error, ...opts }) {
  const reg = registry();
  try {
    fill(reg);
  } catch (e) {
    log(`metrics: nothing pushed: ${e.message}`);
    return false;
  }
  return push(reg, { log, ...opts });
}
