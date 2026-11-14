# Swarm Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the generic part of ops' `couchy-swarm` chart into this repository as a published `swarm` chart, and reduce ops' chart to a wrapper holding couchy's values.

**Architecture:** `charts/swarm/` here holds the CronJob template, the `run.mjs` ConfigMap and two built-in jobs. A workflow pushes it to `oci://ghcr.io/getcouchy/charts` on a `chart-v*` tag. ops' `k8s/charts/couchy-swarm` depends on it and nests couchy's values under `swarm:`.

**Tech Stack:** Helm 3 (OCI registries), Node's built-in test runner, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-14-swarm-chart-design.md`

## Global Constraints

- Two repositories: `getcouchy/swarm` (Tasks 1–2) and `getcouchy/ops` (Task 3), at `../ops` from here. One branch in each, named `swarm-chart`. No pushes or PRs without the owner's say.
- Chart name `swarm`, version `0.1.0`, at `charts/swarm/`.
- CronJob names are the bare job key; the ConfigMap is `<release>-run`.
- `github.secretName` defaults to `swarm-github-app`; `extraSecretName` defaults to `""`; `github.repository` has no default.
- No runtime dependencies in swarm: tests use `node --test` and the `helm` binary only.
- Owner's prose rules (apply to comments, READMEs, commits): never write "load-bearing", "seam", "genuinely", or "wire" as jargon; no trailing clause that restates the sentence.

## Review Focus

- `github.repository` unset: render fails with a message naming the value. (Task 1 test)
- A job with `secretEnv` while `extraSecretName` is empty: render fails naming `extraSecretName`. (Task 1 test)
- A wrapper sets `enabled: false` on a built-in job: no CronJob for it. (Task 1 test)
- A job added by a wrapper with no `source`: runs from `github.repository`. (Task 1 test)
- Upgrading couchy's existing release: resource names and Secret references unchanged. (Task 3 diff)

---

### Task 1: `charts/swarm/` with render tests

**Files:**
- Create: `chart.test.mjs`
- Create: `charts/swarm/Chart.yaml`, `charts/swarm/values.yaml`, `charts/swarm/.helmignore`
- Create: `charts/swarm/templates/_helpers.tpl`, `templates/configmap.yaml`, `templates/cronjobs.yaml`
- Create: `charts/swarm/files/run.mjs`
- Source to copy from: `../ops/k8s/charts/couchy-swarm/`

**Interfaces:**
- Produces, for Task 3, these values: `image`, `github.{repository,ref,secretName}`, `extraSecretName`, `defaults.*` (as in ops today), `jobs.<name>.{enabled,schedule,timeZone,suspend,source,ref,run,env,secretEnv,concurrencyPolicy,startingDeadlineSeconds,activeDeadlineSeconds}`.

- [ ] **Step 1: Write the failing tests** in `chart.test.mjs`

A helper `render(...sets)` runs `helm template t charts/swarm --set <each>` with `spawnSync` and returns `{ status, stdout, stderr }`. The whole file skips when `helm version` doesn't run. Tests:

```js
test('refuses to render without github.repository', () => {
  const r = render();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /github\.repository/);
});
test('built-in jobs run swarm scripts against the given repository', () => {
  const { stdout } = render('github.repository=acme/app');
  assert.deepEqual(cronJobNames(stdout), ['agent-reviewed', 'agent-sweep']);
  assert.match(stdout, /name: GITHUB_REPOSITORY\s+value: "acme\/app"/);
  assert.match(stdout, /name: SOURCE_REPOSITORY\s+value: "getcouchy\/swarm"/);
  assert.match(stdout, /name: swarm-github-app, key: app-id/);
  assert.doesNotMatch(stdout, /couchy-swarm|REVIEWED_CREATOR/);
});
test('enabled=false drops a built-in job', () => {
  const { stdout } = render('github.repository=acme/app', 'jobs.agent-sweep.enabled=false');
  assert.deepEqual(cronJobNames(stdout), ['agent-reviewed']);
});
test("a job's ref overrides github.ref", () => {
  const { stdout } = render('github.repository=acme/app', 'jobs.agent-sweep.enabled=false', 'jobs.agent-reviewed.ref=v1');
  assert.match(stdout, /name: SOURCE_REF\s+value: "v1"/);
});
test('an added job without source runs from github.repository', () => {
  const { stdout } = render('github.repository=acme/app', 'jobs.agent-sweep.enabled=false', 'jobs.agent-reviewed.enabled=false',
    'jobs.mine.schedule=0 * * * *', 'jobs.mine.run={tools/x.mjs}');
  assert.match(stdout, /name: SOURCE_REPOSITORY\s+value: "acme\/app"/);
});
test('secretEnv needs extraSecretName', () => {
  const r = render('github.repository=acme/app', 'jobs.agent-sweep.secretEnv.K=K');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /extraSecretName/);
});
```

`cronJobNames(stdout)` returns the sorted `metadata.name` of each `kind: CronJob` document.

- [ ] **Step 2: Run** `npm test`. Expected: the six chart tests fail (no chart directory).

- [ ] **Step 3: Create the chart.** Copy the four template/file sources from ops, then:
  - `Chart.yaml`: `name: swarm`, `version: 0.1.0`, description "Runs the swarm's housekeeping scripts for one GitHub repository as CronJobs.", `home`/`sources` pointing at `https://github.com/getcouchy/swarm`.
  - Helper renamed `swarm.labels`; every `couchy-swarm` label value becomes `swarm`.
  - `cronjobs.yaml`: skip a job when `enabled` is `false` (an unset `enabled` is true); `GITHUB_REPOSITORY` uses `required "github.repository is required…"`; `SOURCE_REF` is `$job.ref | default $.Values.github.ref`; the `secretEnv` secret name uses `required "extraSecretName is required when a job sets secretEnv"`.
  - `run.mjs`: User-Agent `swarm-chart`; top comment no longer says "the agent tools set it to getcouchy/swarm".
  - `values.yaml`: ops' `image`, `defaults` and comments; `github: { repository: "", ref: main, secretName: swarm-github-app }`; `extraSecretName: ""`; `jobs` holds `agent-reviewed` (`*/2 * * * *`, `activeDeadlineSeconds: 110`, `source: getcouchy/swarm`, `run: [reviewed.mjs]`) and `agent-sweep` (`*/10 * * * *`, `source: getcouchy/swarm`, `run: [sweep.mjs]`). Comments describe `enabled` and `ref`, and drop the "Was .github/workflows/…" history.

- [ ] **Step 4: Run** `npm test` and `helm lint charts/swarm --set github.repository=acme/app`. Expected: all tests pass; lint reports 0 failed.

- [ ] **Step 5: Commit** `chart.test.mjs charts/` with message `charts/swarm: the housekeeping CronJobs, moved from getcouchy/ops`.

### Task 2: Chart README and publishing workflow

**Files:**
- Create: `charts/swarm/README.md`
- Create: `.github/workflows/chart.yml`
- Modify: `README.md` (one paragraph after "Using it in a tick" pointing at the chart)

- [ ] **Step 1: Write `charts/swarm/README.md`** with these sections: what a run does (mints an App token, downloads the source ref's tarball, runs one script); Jobs (the two built-ins, and how to add, retime, pin with `ref`, or disable one); GitHub App (permissions from ops' README minus Projects, which is listed as needed only for scripts that write org projects; the warning not to name it `couchy-<something>` with the `agentFromLogin` reason; the note that a required `reviewed` status must accept the App as its source, and `REVIEWED_CREATOR`); Secrets (`swarm-github-app` with `app-id` and `private-key`; optional `extraSecretName`); Install (`helm upgrade --install swarm oci://ghcr.io/getcouchy/charts/swarm --version 0.1.0 -n swarm --create-namespace --set github.repository=<owner>/<repo>`, then the `kubectl create job --from=cronjob/agent-reviewed` try-one commands); Using it as a dependency (the `dependencies:` stanza and values nested under `swarm:`); Releasing (bump `version`, tag `chart-v<version>`).

- [ ] **Step 2: Write `.github/workflows/chart.yml`.** Triggers: `push` of tags `chart-v*`. One job `publish` with `permissions: { contents: read, packages: write }`: checkout; fail unless `${GITHUB_REF_NAME#chart-v}` equals the `version:` in `charts/swarm/Chart.yaml`; `helm registry login ghcr.io -u ${{ github.actor }}` with `GITHUB_TOKEN` on stdin; `helm package charts/swarm`; `helm push swarm-<version>.tgz oci://ghcr.io/getcouchy/charts`. Pull-request coverage comes from `npm test` in the existing `test.yml` (GitHub's ubuntu runners ship helm), so add a `helm lint charts/swarm --set github.repository=acme/app` step there.

- [ ] **Step 3: Verify** `helm package charts/swarm -d "$TMPDIR"` produces `swarm-0.1.0.tgz`, and both workflow files parse as YAML (`node -e` with no YAML library isn't available; use `ruby -ryaml -e 'YAML.load_file(ARGV[0])'`).

- [ ] **Step 4: Commit** with message `charts/swarm: README, and publish to ghcr on a chart-v tag`. Commit the spec and this plan in the same branch.

### Task 3: ops wrapper chart

**Files (in `../ops`):**
- Modify: `k8s/charts/couchy-swarm/Chart.yaml`, `values.yaml`, `README.md`
- Delete: `k8s/charts/couchy-swarm/templates/`, `k8s/charts/couchy-swarm/files/`
- Create: `k8s/charts/couchy-swarm/.gitignore` (`charts/`)
- Modify: `helm-upgrade.sh`

**Interfaces:**
- Consumes: Task 1's values, nested under `swarm:`.

- [ ] **Step 1: Capture the baseline** before any edit: `helm template couchy-swarm k8s/charts/couchy-swarm -n couchy-swarm > <scratch>/before.yaml`.

- [ ] **Step 2: Rewrite the chart.**
  - `Chart.yaml`: version `0.2.0`; `dependencies: [{ name: swarm, version: 0.1.0, repository: oci://ghcr.io/getcouchy/charts }]`.
  - `values.yaml`, everything under `swarm:`: `github: { repository: getcouchy/couchy, secretName: couchy-swarm }`; `extraSecretName: couchy-swarm-extra`; `jobs.agent-reviewed.env.REVIEWED_CREATOR: getcouchy-swarm[bot]`; the four `tools/ci/*` jobs with their comments, verbatim. Keep the "Was .github/workflows/…" comments for all six jobs here.
  - `README.md`: keep the intro, table, "Not here", the couchy-specific App notes (name `getcouchy-swarm`, Projects permission, install on all repositories, the ruleset paragraph), Secrets and Install; link to `https://github.com/getcouchy/swarm/tree/main/charts/swarm` for how a run works and the values; add how to bump the swarm chart version (`Chart.yaml`, then `helm dependency update`).
  - `helm-upgrade.sh`: `helm dependency build k8s/charts/couchy-swarm` before the upgrade, under the same context guard.
  - `Chart.lock` cannot be generated until `chart-v0.1.0` is published; say so in the handoff instead of committing a fake one.

- [ ] **Step 3: Verify against the baseline.** Package Task 1's chart into `k8s/charts/couchy-swarm/charts/` (`helm package ../swarm/charts/swarm -d k8s/charts/couchy-swarm/charts`), render to `<scratch>/after.yaml`, and `diff` the two. Expected differences only: `# Source:` paths, `app.kubernetes.io/name` and `helm.sh/chart` label values, and the comment and User-Agent lines of `run.mjs`. Any other line is a defect.

- [ ] **Step 4: Commit** with message `couchy-swarm: depend on the swarm chart, keep couchy's values`.
