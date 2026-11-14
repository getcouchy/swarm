# A swarm Helm chart, published from this repository

2026-11-14

## Intent

swarm is to be something another org can adopt, and running its housekeeping
(the `reviewed` status, the sweep) is part of adopting it. The chart that does
that for couchy lives in getcouchy/ops as `couchy-swarm`, with couchy's
repository, secrets and extra jobs mixed into generic templates. The generic
part moves here and is published; ops keeps what is couchy's.

## Goals

- `charts/swarm/` in this repository: installable by any org with a GitHub App
  and a repository name.
- Published as `oci://ghcr.io/getcouchy/charts/swarm`.
- ops' `couchy-swarm` becomes a wrapper chart that depends on it and holds
  couchy's values, with room for its own templates.
- The existing `couchy-swarm` release upgrades in place: same CronJob names,
  same ConfigMap name, same Secrets.

## Non-goals

- Making the tools themselves org-neutral (`couchy-<name>` bot names,
  `COUCHY_BOT_*` variables, the getcouchy default org). Separate change.
- Changing any job's schedule or behavior.

## Anti-goal

A chart that needs couchy's values to render, or one where couchy has to copy
templates back into ops to add a job.

## Approaches

1. **Published OCI chart, wrapper chart in ops (picked).** Other orgs install
   it with one `helm install oci://…`; ops pins a version and can add
   templates. Costs a release step per chart change.
2. Pinned git ref: `helm-upgrade.sh` clones swarm at a tag and installs the
   chart directory with `-f values.yaml`. Nothing to publish, but ops gets no
   place for its own templates.
3. Git submodule with a `file://` dependency. No registry, but the submodule
   needs bumping by hand and outside users still have no install command.

## Design

### swarm: `charts/swarm/`

Moved from ops unchanged in behavior: `templates/cronjobs.yaml`,
`templates/configmap.yaml`, `templates/_helpers.tpl`, `files/run.mjs`.

Changes:

- Chart name `swarm`. The hard-coded `app.kubernetes.io/name: couchy-swarm`
  labels and the `couchy-swarm` User-Agent become `swarm`.
- `github.repository` has no default and the chart fails to render without it.
- `github.secretName` defaults to `swarm-github-app` (keys `app-id`,
  `private-key`). `extraSecretName` defaults to empty; a job with `secretEnv`
  fails to render without it.
- `jobs` ships with `agent-reviewed` and `agent-sweep`, the two that run this
  repository's own scripts (`source: getcouchy/swarm`), at today's schedules.
  `REVIEWED_CREATOR` is unset by default.
- Each job takes `enabled` (default true), so a wrapper can turn a built-in
  job off, and `ref` (default `github.ref`), so the tools can be pinned to a
  tag while the target repository's scripts follow main.
- CronJob names stay the bare job key, and the ConfigMap stays
  `<release>-run`. One install per namespace.
- `README.md`: what a run does, the GitHub App and its permissions (including
  the warning not to name it `couchy-<something>`), the Secrets, the values,
  install and try-one commands.

### swarm: publishing

- `.github/workflows/chart.yml`: on pull requests touching `charts/**`,
  `helm lint` and `helm template` with a sample repository. On a `chart-v*`
  tag, check the tag matches `Chart.yaml`'s version, `helm package`, and
  `helm push` to `oci://ghcr.io/getcouchy/charts` with the workflow's
  `GITHUB_TOKEN` (`packages: write`).
- One manual step, once: set the ghcr package's visibility to public after the
  first push.

### ops: `k8s/charts/couchy-swarm/`

- `Chart.yaml` gains a dependency on `swarm` at a pinned version from
  `oci://ghcr.io/getcouchy/charts`. `Chart.lock` is committed; `charts/*.tgz`
  is ignored.
- `templates/` and `files/` are deleted.
- `values.yaml` keeps only couchy's settings, under `swarm:`:
  `github.repository: getcouchy/couchy`, the two secret names,
  `REVIEWED_CREATOR` on `agent-reviewed`, and the four `tools/ci/*` jobs.
- `README.md` keeps couchy's table, history, ruleset note and commands, and
  links to the swarm chart for the rest.
- `helm-upgrade.sh` runs `helm dependency build` before the upgrade.

### Order

1. swarm PR merges, `chart-v0.1.0` is tagged, the package is made public.
2. ops PR merges and is deployed.

### Verification

Render the current ops chart and the new wrapper (against the local
`charts/swarm` until it is published) and diff the manifests. The only
differences allowed are the `name`/`helm.sh/chart` labels, the User-Agent line
in `run.mjs`, and the comment at its top.

## Left to the builder

Wording of both READMEs; the exact shape of the lint job.
