# Swarm metrics: Prometheus and a Grafana dashboard

## Intent

The Agent desk issue is the only view of what the agents are doing and what is
overdue. The sweep adds a comment for each newly overdue item and each fix, so
the issue has grown too long to read. The owner wants the same data as
Prometheus metrics behind a Grafana dashboard that can be filtered by
repository, agent, and issue or PR.

## Goals

- Every fact the desk shows is a metric, labelled so it can be filtered by
  repository, agent, and issue or PR number.
- Metric definitions live in getcouchy/swarm, usable by any install of the chart.
- A dashboard ships with the definitions.
- With no Pushgateway configured, the tools behave as they do today.

## Non-goals

- What a tick did (jobs taken, duration, cost). That needs the heartbeat comment
  to carry data, a protocol change. Second phase.
- Removing the desk issue or the heartbeat comments. PROTOCOL.md depends on both.
- Metrics from getcouchy/couchy's own scripts (conflict-alerts, ship-report…).

## Anti-goals

- A push failure must never fail the sweep or `reviewed`: `reviewed` is a
  required check, and a pull request cannot merge while its CronJob fails.
- No second implementation of the rules. Metrics come from the values
  `sweep()` already computes.

## Constraints

- kube-1 runs plain Prometheus (prometheus-community chart, no operator, no
  ServiceMonitor) with a Pushgateway at
  `http://prometheus-prometheus-pushgateway.homelab.svc:9091`, already used by
  the backup CronJobs. kube-state-metrics is on. Alloy ships every pod's logs
  to Loki with a `namespace` label.
- Grafana loads dashboards from ConfigMaps labelled `grafana_dashboard: "1"` in
  namespace `homelab` only. Datasource uids are `prometheus` and `loki`.
- The jobs run in namespace `couchy-swarm`; the deployer's service account is
  bound to that namespace alone.
- Tick sandboxes cannot reach the cluster. GitHub is their only channel.
- swarm's tools have no dependencies (`node --test`, nothing installed).
- `sweep.mjs` and `reviewed.mjs` run from `main` at each run; `run.mjs` and the
  templates change only with a chart release.

## Approaches

1. **Push from the scripts to the Pushgateway (chosen).** At the end of a run,
   `sweep.mjs` and `reviewed.mjs` PUT their metrics. A PUT replaces the whole
   group, so series for items that are no longer open or overdue vanish. Matches
   how the cluster's other CronJobs report. No new workload.
2. **A long-running exporter that polls GitHub.** Scrapeable and could hold real
   counters, but it re-implements or re-runs the sweep's reads, doubles the API
   calls, and adds a Deployment to keep alive.
3. **Ticks push their own metrics.** Ruled out: the sandboxes have no route to
   the cluster.

The owner approved approach 1.

## Design

### metrics.mjs (new, in swarm's root)

- The table of metric definitions (name, help, type, label names) as one
  exported constant; the docs table is checked against it in a test.
- A registry: `set(name, labels, value)`; rejects an undefined metric or a label
  not in its definition.
- `render()`: Prometheus text exposition, with label values escaped.
- `push(url, job, repository)`: PUT to
  `<url>/metrics/job/<job>/repository@base64/<base64url of owner/name>`. Times
  out after a few seconds; on any failure logs one line and returns. Does
  nothing when the URL is unset or `DRY_RUN=true`.
- The URL comes from `SWARM_PUSHGATEWAY_URL`.

### Metrics

Gauges, except the two `_total` counters. `repository` reaches every series through the grouping key.
`agent` is the lock holder's name where there is one, else the agent the PR
author's bot login maps to (`agentFromLogin`), else empty.

| Metric | Labels | Value |
|---|---|---|
| `swarm_agent_last_tick_timestamp_seconds` | `agent` | `updated_at` of the agent's heartbeat comment |
| `swarm_pulls` | `number`, `state`, `agent` | 1 per open swarm or review-only PR |
| `swarm_issues` | `number`, `state`, `agent` | 1 per approved open issue; `state` is `claimable` or `locked` |
| `swarm_lock_age_seconds` | `number`, `agent`, `type` (`issue`/`pull`) | time since the lock label went on |
| `swarm_overdue_age_seconds` | `number`, `kind`, `agent` | how long the item has been in that condition; `number` is empty for `kind="quiet"`, where `agent` names the agent |
| `swarm_limit_seconds` | `limit` | the configured claim, ready, review, fix, hold and heartbeat limits |
| `swarm_sweep_fixed` | `action` (`lock_lapsed`, `lock_doubled`, `label_migrated`) | count in the last run; all three always present, 0 when none |
| `swarm_needs_human_total` | `type` (`issue`/`pull`), `agent` | counter: times `swarm/needs-human` went onto an item |
| `swarm_hold_total` | `agent` | counter: times `swarm/hold` went onto a PR |
| `swarm_reviewed_pulls` | `number`, `state` (`success`/`failure`/`pending`) | 1 per open PR, as of the last `reviewed` run |
| `swarm_job_last_success_timestamp_seconds` | none | set when the run completes |
| `swarm_job_duration_seconds` | none | the last run's duration |
| `swarm_github_rate_limit_remaining` | none | from the last response's `x-ratelimit-remaining` |

The three `swarm_job_*`/rate-limit metrics are told apart by the `job` label
the grouping key supplies (`swarm_sweep`, `swarm_reviewed`); the Pushgateway
refuses a pushed series that carries its own `job`.

`swarm_pulls` states, first match wins: `draft`, `needs_human`, `hold` (each
by its label, so the current count of either is a query), `needs_work` (`fixReasons` is non-empty),
`needs_review`, `merging` (auto-merge on), `merge_ready`, else `waiting`.

`kind` is the prefix of the desk-state key the sweep already assigns: `ready`,
`review`, `fix`, `hold`, `held`, `merge`, `draft`, `human`, `quiet`, `stages`,
`unapproved`.

Counts are PromQL (`count by (state) (swarm_pulls)`); no aggregate series are
pushed. Titles are not labels.

### The two counters

A run lasts seconds, so the totals are kept between runs in the desk issue's
body, which the sweep already rewrites each run: a second marker beside
`agent-desk-state`,
`<!-- swarm-counters: {"needsHuman":{"issue|claude":3,…},"hold":{…},"labelled":{"needsHuman":[7,31],"hold":[34]}} -->`.

- Each run lists the open items carrying each label (it already has them, so no
  extra API calls). An item that carries the label now and is not in the
  previous `labelled` set adds 1 to that label's total, under the item's
  `agent` as defined above.
- The first run, or a marker that fails to parse, starts the totals at 0 and
  records the current set without counting it.
- A dry run reads the marker and writes nothing.
- A label added and removed between two runs (10 minutes) is not counted; one
  removed and added again is counted again.
- A reset to 0 (the desk issue is recreated) is an ordinary counter reset to
  Prometheus; `increase()` handles it.
- The counters carry no `number` label: a series per item that only ever reads
  1 is the gauges' job.

### sweep.mjs and reviewed.mjs

- `flag()` takes the item's number, agent and the timestamp its wait began, next
  to the line it takes today. `sweep()` returns those and the per-PR and
  per-issue states. The desk output does not change.
- `github.mjs` records the last `x-ratelimit-remaining` it saw.
- Each script's entry point fills the registry and pushes after its work is
  done. A run that throws pushes nothing, so `last_success` goes stale.
- **`DESK_COMMENTS=false`** (my call): the sweep still rewrites the desk body
  but adds no "Newly overdue / Fixed by the sweep" comment. Default `true`.
  This changes what the sweep reports, which the owner asked for (AGENTS.md).

### Chart (charts/swarm)

- `metrics.pushgatewayUrl` (default empty) sets `SWARM_PUSHGATEWAY_URL` on
  every job.
- `charts/swarm/dashboards/swarm.json`: the dashboard, with datasource
  variables defaulting to uids `prometheus` and `loki`.
- README section and a metrics reference (`docs/metrics.md`). Version bump.

### Dashboard

Variables: repository, agent. Rows:

1. Agents: time since last tick per agent against the heartbeat limit; locks held.
2. Queue: claimable issues over time; table of locked issues with lock age.
3. Pull requests: count by state over time; table by number, state, agent.
4. Overdue: table by kind, number, agent, age, linking to GitHub.
5. Housekeeping: job freshness and duration, rate limit left, failed Jobs from
   `kube_job_status_failed{namespace=...}`.
6. Events: Loki panel of the sweep's `fixed:` and `overdue:` log lines.

### ops (k8s/charts/couchy-swarm)

Bump the swarm dependency; set `swarm.metrics.pushgatewayUrl`. Once the
dashboard is confirmed working, set `DESK_COMMENTS: "false"` on agent-sweep.

### homelab

- Copy `swarm.json` into `k8s/charts/grafana-dashboards/dashboards/` and bump
  that chart, as `couchy.json` is handled today (my call; the alternative is the
  swarm chart shipping a ConfigMap and Grafana's sidecar also watching
  `couchy-swarm`, which needs an RBAC change to Grafana).
- Optional alert rules in `grafana-alerting`: an agent quiet past the limit,
  the sweep's last success older than 30 minutes, any `kind="human"` item.

## Left to the builder

- The exact shape of what `sweep()` returns for states.
- Panel types and layout.
- Whether the Pushgateway's scrape job on kube-1 honours pushed labels; confirm
  on the cluster before relying on `job` (the chart's default job does).

## Order

1. swarm: `metrics.mjs`, the emits, the chart value, the dashboard, docs.
2. ops: bump and set the URL.
3. homelab: dashboard copy, then alerts.
4. ops: turn the desk comments off.
