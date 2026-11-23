# Metrics

`sweep.mjs` and `reviewed.mjs` report what they find as Prometheus metrics, so
the state of the swarm can be read from a dashboard instead of from the Agent
desk work item. The definitions are in [`lib/metrics.mjs`](../lib/metrics.mjs); a test
holds this page to them.

## How they get to Prometheus

A run is over in seconds, before Prometheus could scrape it, so each run ends
by pushing to a [Pushgateway](https://github.com/prometheus/pushgateway), which
Prometheus scrapes. Set `SWARM_PUSHGATEWAY_URL` to its address
(`http://pushgateway:9091`); in the chart that is `metrics.pushgatewayUrl`.
Unset, nothing is pushed. `DRY_RUN=true` pushes nothing either.

A Pushgateway that is down, slow or refusing costs the run one logged line.
The run still succeeds: `reviewed` is a required check, and a pull request
must not wait on a metrics outage.

Each push replaces everything the same job pushed for the repository before.
A series for a pull request that has merged, or an item that is no longer
overdue, is gone after the next run. For the same reason a `reviewed` run for
one pull request (`node reviewed.mjs 123`) pushes nothing.

Two labels come from the push and are on every series:

| Label | Value |
| --- | --- |
| `job` | `swarm_sweep` or `swarm_reviewed` |
| `repository` | `owner/name`, from `GITHUB_REPOSITORY` |

The Pushgateway's scrape job needs `honor_labels: true`, as the
prometheus-community chart's has; without it Prometheus renames `job` to
`exported_job`.

## The metrics

`agent` is who the item is with: the holder of its `swarm/agent/<name>` lock,
else the agent whose bot (`couchy-<name>[bot]`) opened it, else empty.
`number` is the work item's key (`COU-12`) or the pull request's number. There are no counts: count the
series (`count by (state) (swarm_pulls)`).

| Metric | Type | Labels | Value |
| --- | --- | --- | --- |
| `swarm_agent_last_tick_timestamp_seconds` | gauge | `agent` | When the agent last edited its heartbeat comment on the desk. An agent with several comments reports its newest. |
| `swarm_pulls` | gauge | `number`, `state`, `agent` | 1 for each open pull request the agents work on or review. |
| `swarm_issues` | gauge | `number`, `state`, `agent` | 1 for each ready work item (in Todo or In Progress): `locked` when an agent holds it, `claimable` when one could take it. One that is neither is left out: one with open sub-issues, one with a pull request open for it, one marked `swarm/hands-off`. Blockers are not looked up, so a blocked item reads `claimable`. |
| `swarm_lock_age_seconds` | gauge | `number`, `agent`, `type` | How long the agent's lock has been on. `type` is `issue` (a work item) or `pull`. |
| `swarm_overdue_age_seconds` | gauge | `number`, `kind`, `agent` | One series for each line on the desk: how long the item has been in that condition. 0 where the sweep has no time to measure from. An agent with several heartbeat comments has one line on the desk, from its newest. |
| `swarm_limit_seconds` | gauge | `limit` | The limits the sweep ran with: `claim`, `ready`, `review`, `fix`, `hold`, `heartbeat`. |
| `swarm_sweep_fixed` | gauge | `action` | What the last run fixed: `lock_lapsed`, `lock_doubled`, `label_migrated`. |
| `swarm_needs_human_total` | counter | `type`, `agent` | Times a work item went to Needs Human or `swarm/needs-human` went onto a pull request. |
| `swarm_hold_total` | counter | `agent` | Times `swarm/hold` went onto a pull request. |
| `swarm_reviewed_pulls` | gauge | `number`, `state` | 1 for each open pull request, by the `reviewed` status of its head: `success`, `failure` or `pending`. |
| `swarm_job_last_success_timestamp_seconds` | gauge | | When the job last ran to its end. A run that fails pushes nothing, so this goes stale. |
| `swarm_job_duration_seconds` | gauge | | How long the last run took. |
| `swarm_github_rate_limit_remaining` | gauge | | GitHub API requests left in the token's hour after the last run. |

### A pull request's state

The first of these that holds:

| `state` | When |
| --- | --- |
| `draft` | it is a draft |
| `needs_human` | it carries `swarm/needs-human` |
| `hold` | it carries `swarm/hold` |
| `needs_work` | it conflicts with main, a check failed, or changes were requested since the last push |
| `needs_review` | it waits for a review |
| `merging` | auto-merge is on |
| `merge_ready` | it could merge and auto-merge is off |
| `waiting` | none of the above |

### What is overdue

`kind` is the part of the desk the item is listed under:

| `kind` | Desk section |
| --- | --- |
| `ready` | Waiting for an agent |
| `unapproved` | Claims |
| `draft` | Unfinished work nobody is on |
| `review` | Pull requests waiting for review |
| `fix` | Pull requests that need work |
| `held` | Pull requests set to merge that should not be |
| `hold` | Pull requests held from merging |
| `merge` | Pull requests not set to merge |
| `human` | Needs you |
| `qa` | Waiting for your review |
| `shape` | Waiting for shaping |
| `shaped` | Shaped, waiting for you |
| `quiet` | Agents not ticking; `number` is empty and `agent` names the agent |

### The two counters

A run can't remember the last one, so the totals are kept on the desk, in a
`swarm-counters` HTML comment beside the one that holds the desk's state. On
a work item, whose description a person may edit by hand, both are in the one
desk comment the sweep edits each run; on a GitHub issue, in its body. Each run compares the items that carry the label now with those that
carried it at the last run:

- an item that carries it now and didn't then adds one;
- a label that went on and came off between two runs is not counted, and one
  that came off and went back on is counted again;
- the first run, or a comment somebody broke by hand, starts from 0 and counts
  nothing that is already labelled;
- a desk work item that is closed and made anew starts from 0 again, which
  Prometheus reads as an ordinary counter reset.

`agent` is who the item was with when the sweep first saw the label, which is
not always who put it on.

Every agent a run sees on a pull request, a work item or a lock has both counters
out at 0 from then on, because `increase()` reads nothing from a series that
first appears at 1. An agent the sweep first sees in the same run that counts
it loses that one from `increase()`; the total is still right.

## The desk's comments

With the metrics in a dashboard and alerts on them, the comment the sweep adds
for each newly overdue item is noise. `DESK_COMMENTS=false` on the sweep stops
those comments, and the sentence in the desk's body that promises them. The
body is still rewritten each run, and the agents' heartbeat comments are
untouched.

The sweep's log keeps the same history: a `fixed:` line for each fix and an
`overdue:` line for each overdue item, every run.

## Dashboard

[`charts/swarm/dashboards/swarm.json`](../charts/swarm/dashboards/swarm.json)
is a Grafana dashboard over these metrics. Import it, or load it the way your
Grafana loads dashboards. It expects a Prometheus datasource and, for its log
panel, a Loki one that has the jobs' pod logs.

It also reads the `tick_*` metrics that
[getcouchy/agent-runner](https://github.com/getcouchy/agent-runner)'s tick
runner pushes to the same Pushgateway, matched to the repository by the `repo`
label of `tick_info`. "Since each agent last ticked" takes an agent's last run
start from the runner, and its heartbeat comment only for an agent no runner
reports. The Runner row shows runs by how they ended, runs in flight and each
agent's last run duration, and is empty without a runner.

"Locks", "Locks held" and the two handoff panels take an agent's numbers from
its runner once the runner reports them (`tick_github_rate_limit_remaining`
for locks, `tick_handoffs_total` for handoffs), and the sweep's only for an
agent whose runner does not; both count the same locks and handoffs, so one
agent never gets both. The runner's handoffs carry their own `repository`, so
each repository's dashboard counts only the handoffs made in it. "On now" and
"Last run" list the runner's jobs in flight and those of each agent's last run.

The Work row reads the tick runner's item log from Loki (lines starting
`{"tick_item":`, labelled `service="tick-runner"` and `agent`), keyed by each
line's `item`: a work item's Linear key (`COU-34`) or a pull request's
number. "Worked on" lists each work item and pull request in the repository
that an agent touched in the time range, with its latest title, the agents and
jobs, the time its finished jobs took and its last activity; an item only
claimed or handed off is there too, with no time. A work item links to Linear
under the dashboard's hidden `tracker` constant (the workspace's URL,
`https://linear.app/couchy`), at `<tracker>/issue/<key>`, a pull request to
GitHub. "Item timeline" lists everything done to the item typed
into the Item box (`COU-34`, `57` or `#57`), oldest first, and is empty
while the box is. A pull request's line carries `work_item`, the key its body
closes or is part of, and a work item's line `pulls`, its open pull requests,
so a key in the box also lists what was done to that work item's pull requests,
and `| json | work_item="COU-34"` in Explore is every pull request an
agent touched for it. "Agent log" lists every line from the chosen agents' tick
containers, the runner's own lines as written and item lines rewritten to read
like the timeline; one agent over the span of a run is that run.
