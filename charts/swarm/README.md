# swarm chart

Runs the swarm's housekeeping for one GitHub repository as Kubernetes CronJobs:
the `reviewed` status, the sweep, and any script of your own that only needs a
GitHub token and the API. None of them needs a PR's code, so they don't have to
take a CI runner.

Each run mints a one-hour installation token for a GitHub App, downloads the
tarball of the job's source repository at its ref, and runs one script from it
with the token in `GITHUB_TOKEN`. A change to a script on that ref applies from
the next run.

## Jobs

| CronJob | Script | Schedule |
| --- | --- | --- |
| agent-reviewed | [`reviewed.mjs`](../../reviewed.mjs) | every 2 min |
| agent-sweep | [`sweep.mjs`](../../sweep.mjs) | every 10 min |

Both come from this repository's `main`. In your values, under `jobs`:

```yaml
jobs:
  agent-reviewed:
    ref: chart-v0.1.0          # pin the tools to a tag instead of main
    env:
      REVIEWED_CREATOR: my-swarm[bot]
  agent-sweep:
    enabled: false             # remove a built-in job
  nightly-report:              # add your own; with no `source` it runs from github.repository
    schedule: "0 8 * * *"
    timeZone: America/Los_Angeles
    run: [tools/report.mjs, --send]
    secretEnv:
      MAIL_API_KEY: MAIL_API_KEY
```

[`values.yaml`](values.yaml) lists every key a job takes.

## Metrics

Set `metrics.pushgatewayUrl` to a Prometheus Pushgateway and the sweep and
`reviewed` push what they find there at the end of each run: every open pull
request and approved issue by state, the agents' locks and last ticks, what is
overdue and for how long, and each job's last success.
[`docs/metrics.md`](../../docs/metrics.md) lists them.

```yaml
metrics:
  pushgatewayUrl: http://prometheus-pushgateway.monitoring.svc:9091
```

The job pods must be able to reach that address. A Pushgateway that is down
never fails a run.

[`dashboards/swarm.json`](dashboards/swarm.json) is a Grafana dashboard over
the metrics. Once it shows what the Agent desk's comments told you, set
`DESK_COMMENTS: "false"` under `jobs.agent-sweep.env` to stop them.

## GitHub App

Create a GitHub App owned by your org, with no webhook. Repository permissions:
Contents read, Issues write, Pull requests write, Commit statuses write, Checks
read, Metadata read. A script of yours that writes an org project also needs
the organization permission Projects write. Install it on the repository in
`github.repository` and on any private repository a job names as its `source`,
and generate a private key.

Don't name the App `couchy-<something>`: the agent rules read
`couchy-<name>[bot]` as an agent's own bot (`agentFromLogin` in
[`rules.mjs`](../../rules.mjs)), and its reviews would count as an agent's.

If `reviewed` is a required status check, the branch rule must accept it from
this App. Set `REVIEWED_CREATOR` to the App's bot login (`<app-slug>[bot]`) so
that only its own status counts as already posted.

## Secrets

```sh
kubectl create namespace swarm
kubectl -n swarm create secret generic swarm-github-app \
  --from-literal=app-id=<APP_ID> --from-file=private-key=<app>.private-key.pem
```

`github.secretName` names a different Secret. Jobs that set `secretEnv` read
from the Secret named in `extraSecretName`; a key missing from it leaves the
variable unset.

## Install

```sh
helm upgrade --install swarm oci://ghcr.io/getcouchy/charts/swarm --version 0.2.0 \
  -n swarm --set github.repository=<owner>/<repo>
# Try one before waiting for the schedule:
kubectl -n swarm create job --from=cronjob/agent-reviewed reviewed-now
kubectl -n swarm logs -f job/reviewed-now
```

CronJobs are named by their job key, so install one release per namespace.

## As a dependency

To keep your values and your own templates in a chart of yours:

```yaml
# Chart.yaml
dependencies:
  - name: swarm
    version: 0.2.0
    repository: oci://ghcr.io/getcouchy/charts
```

```yaml
# values.yaml
swarm:
  github:
    repository: <owner>/<repo>
```

## Releasing

Bump `version` in `Chart.yaml` in the pull request that changes the chart; the
Chart workflow fails one that changes it under a version already published.
Merging to main publishes that version to `oci://ghcr.io/getcouchy/charts` and
tags the commit `chart-v<version>`. Run workflow retries a publish that failed.

After the first publish, set the `charts/swarm` package's visibility to public
in the org's package settings; until then installing it needs
`helm registry login ghcr.io`.

`npm test` renders the chart when `helm` is installed.
