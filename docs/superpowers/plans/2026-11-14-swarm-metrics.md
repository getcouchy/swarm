# Swarm Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The sweep and `reviewed` push Prometheus metrics to a Pushgateway, and a Grafana dashboard reads them.

**Architecture:** A dependency-free `metrics.mjs` holds the metric definitions, a registry, the text format and the push. `sweep()` returns structured facts next to the lines it returns today; pure functions turn those into registry entries; the entry points push after their work. Two counters persist in a marker in the desk issue's body.

**Tech Stack:** Node 20+ ESM with no dependencies, `node --test`, Helm, Prometheus Pushgateway, Grafana dashboard JSON.

**Spec:** `docs/superpowers/specs/2026-11-14-swarm-metrics-design.md`

## Global Constraints

- No npm dependencies. `npm test` must pass with nothing installed.
- A push failure never throws and never changes an exit code.
- With `SWARM_PUSHGATEWAY_URL` unset, or `DRY_RUN=true`, nothing is pushed.
- The desk body and comments are unchanged unless `DESK_COMMENTS=false`; the only addition to the body is the `swarm-counters` marker.
- Metric names, label names and label values are exactly those in the spec's table.
- Banned in code comments, commit messages and docs (owner's rule): "load-bearing", "seam", "genuinely", and "wire" as jargon.
- Tasks 1 to 7 are one branch, `swarm-metrics`, cut from `main` of getcouchy/swarm (the checkout is currently on `swarm-chart`). Tasks 8 to 10 are other repositories and wait on the ones before them.

## Review Focus

- Pushgateway unreachable, slow, or answering 4xx/5xx: the run still exits 0 and logs one line (Task 1).
- Label values with `"`, `\`, newlines, or `/` (heartbeat ids look like `grok/1`): rendered escaped, never a broken exposition (Task 1).
- Desk body with no counters marker, or one a person mangled: totals start at 0, the current set is recorded, nothing is counted, nothing throws (Task 3).
- No desk issue yet (first run in a repository): the sweep creates it with a counters marker and pushes metrics (Task 3).
- A PR opened by a person with no lock: `agent=""`, still one `swarm_pulls` series (Task 2).

---

### Task 1: metrics.mjs

**Files:**
- Create: `metrics.mjs`
- Test: `metrics.test.mjs`

**Interfaces:**
- Produces:
  - `METRICS`: `{ [name]: { type: 'gauge' | 'counter', help: string, labels: string[] } }`, with exactly the spec table's thirteen names and label lists (`repository` and `job` are not listed; the grouping key supplies them).
  - `registry()` → `{ set(name, labels, value), render() }`. `set` throws on a name not in `METRICS`, on a label key not in its definition, and fills absent labels with `''`. Setting the same name and labels again replaces the value.
  - `render()` → text exposition: one `# HELP` and `# TYPE` per metric that has samples, then its samples; ends with a newline.
  - `push(reg, { job, repository, url = process.env.SWARM_PUSHGATEWAY_URL, dryRun = process.env.DRY_RUN === 'true', fetchImpl = fetch, log = console.error, timeoutMs = 5000 })` → `Promise<boolean>`. `PUT ${url}/metrics/job/${job}/repository@base64/${base64url(repository)}`, body `reg.render()`, `Content-Type: text/plain; version=0.0.4`. Returns `false` without calling `fetchImpl` when `url` is empty or `dryRun`. Any rejection, timeout or non-2xx: `log` one line, return `false`.

- [ ] **Step 1: Write the failing tests** in `metrics.test.mjs`

```js
test('render: help, type, escaped labels', () => {
  const r = registry();
  r.set('swarm_agent_last_tick_timestamp_seconds', { agent: 'grok/1' }, 1700000000);
  r.set('swarm_lock_age_seconds', { number: '7', agent: 'a"b\\c\nd', type: 'issue' }, 60);
  const out = r.render();
  assert.match(out, /# TYPE swarm_agent_last_tick_timestamp_seconds gauge\n/);
  assert.match(out, /swarm_agent_last_tick_timestamp_seconds\{agent="grok\/1"\} 1700000000\n/);
  assert.match(out, /agent="a\\"b\\\\c\\nd"/);
  assert.ok(out.endsWith('\n'));
});
test('set: refuses an undefined metric or label; a repeat replaces', () => {
  const r = registry();
  assert.throws(() => r.set('swarm_nope', {}, 1));
  assert.throws(() => r.set('swarm_pulls', { title: 'x' }, 1));
  r.set('swarm_hold_total', { agent: 'codex' }, 1);
  r.set('swarm_hold_total', { agent: 'codex' }, 2);
  assert.equal(r.render().match(/^swarm_hold_total\{/gm).length, 1);
  assert.match(r.render(), /# TYPE swarm_hold_total counter/);
});
test('push: PUT to the repository group; off without a url or on a dry run', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push([url, init.method]); return { ok: true, status: 200 }; };
  const r = registry();
  assert.equal(await push(r, { job: 'swarm_sweep', repository: 'acme/app', url: 'http://pg:9091', dryRun: false, fetchImpl }), true);
  assert.deepEqual(calls, [['http://pg:9091/metrics/job/swarm_sweep/repository@base64/YWNtZS9hcHA', 'PUT']]);
  assert.equal(await push(r, { job: 'j', repository: 'a/b', url: '', dryRun: false, fetchImpl }), false);
  assert.equal(await push(r, { job: 'j', repository: 'a/b', url: 'http://pg', dryRun: true, fetchImpl }), false);
  assert.equal(calls.length, 1);
});
test('push: a refusal, a throw and a hang are logged, not thrown', async () => {
  const lines = [];
  const opts = { job: 'j', repository: 'a/b', url: 'http://pg', dryRun: false, log: (l) => lines.push(l), timeoutMs: 20 };
  assert.equal(await push(registry(), { ...opts, fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'bad' }) }), false);
  assert.equal(await push(registry(), { ...opts, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), false);
  assert.equal(await push(registry(), { ...opts, fetchImpl: (u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))) }), false);
  assert.equal(lines.length, 3);
});
test('definitions: every name is swarm_*, counters end in _total', () => {
  for (const [name, d] of Object.entries(METRICS)) {
    assert.match(name, /^swarm_[a-z_]+$/);
    assert.equal(d.type === 'counter', name.endsWith('_total'));
    assert.ok(!d.labels.includes('job') && !d.labels.includes('repository'));
  }
  assert.equal(Object.keys(METRICS).length, 13);
});
```

- [ ] **Step 2:** Run `node --test metrics.test.mjs`. Expected: FAIL, cannot find `./metrics.mjs`.
- [ ] **Step 3:** Implement `metrics.mjs` to the Interfaces above. The timeout is `AbortSignal.timeout(timeoutMs)` passed as `signal`.
- [ ] **Step 4:** Run `node --test metrics.test.mjs`. Expected: PASS.
- [ ] **Step 5:** Commit: `metrics.mjs: metric definitions, text format and Pushgateway push`.

---

### Task 2: sweep() returns structured facts

**Files:**
- Modify: `sweep.mjs` (`sweep`, lines 79-221), `rules.mjs` (new `pullState`)
- Test: `agents.test.mjs` (extend the big sweep test near line 250; add one for `pullState`)

**Interfaces:**
- Produces, in `rules.mjs`: `pullState(pr, { reviews, checks, pushedAt, gated })` → one of `'draft' | 'needs_human' | 'hold' | 'needs_work' | 'needs_review' | 'merging' | 'merge_ready' | 'waiting'`, first match in that order: `pr.draft`; label `NEEDS_HUMAN`; label `HOLD`; `fixReasons(...)` non-empty; `needsReview(pr, reviews, pushedAt)`; `pr.auto_merge`; `mergeReady(pr, { reviews, checks, gated })`.
- Produces, in `rules.mjs`: `agentOf(item)` → `providers(item)[0] ?? agentFromLogin(item.user?.login) ?? ''`.
- Produces, added to what `sweep()` returns (existing `fixed`, `overdue`, `desk` unchanged in content):
  - each `overdue` entry gains `number` (number or `null`), `agent` (string), `since` (ISO string or `null`), `kind` (the key's prefix)
  - `pulls`: `[{ number, state, agent }]` for every PR where `isReviewable(pr)`
  - `issues`: `[{ number, state: 'claimable' | 'locked', agent }]` for open issues labelled `READY`: `locked` when `providers(issue).length` after this run's removals, else `claimable` when `!whyNotClaimable(issue, ctx)`, else left out. Blockers are not consulted (no extra API calls).
  - `locks`: `[{ number, agent, type: 'issue' | 'pull', since }]` for locks still on after this run's removals; `since` is the `lastLabeled` value the lapse loop already reads
  - `heartbeats`: `[{ agent, at }]`, one per heartbeat comment (`heartbeatId`, `updated_at`)
  - `fixedCounts`: `{ lock_lapsed: n, lock_doubled: n }`
  - `labelled`: `{ needsHuman: [{ number, type, agent }], hold: [{ number, agent }] }` for open items carrying each label now
- `since` per kind: the timestamp each branch already compares against the limit; for `human`, the last `labeled` event for `NEEDS_HUMAN` (one `gh.events` call per such item) falling back to `created_at`; `null` for `stages` and `unapproved`. For `quiet`, `number` is `null` and `agent` is the heartbeat id.

- [ ] **Step 1: Write the failing tests.** In the existing sweep test, after the current assertions:

```js
  const by = (rows) => Object.fromEntries(rows.map((r) => [r.number, r]));
  assert.equal(by(result.pulls)[36].state, 'draft');
  assert.equal(by(result.pulls)[33].state, 'hold');
  assert.equal(by(result.pulls)[31].state, 'needs_work');
  assert.equal(by(result.pulls)[30].state, 'needs_review');
  assert.equal(by(result.pulls)[30].agent, '');
  assert.deepEqual(by(result.issues)[3], { number: 3, state: 'locked', agent: 'claude' });
  assert.equal(by(result.issues)[4].state, 'claimable');
  assert.deepEqual(result.locks.map((l) => `${l.type}:${l.number}:${l.agent}`).sort(), ['issue:2:codex', 'issue:3:claude']);
  assert.deepEqual(result.heartbeats.map((h) => h.agent).sort(), ['codex/1', 'grok/1']);
  assert.deepEqual(result.fixedCounts, { lock_lapsed: 2, lock_doubled: 1 });
  assert.deepEqual(result.labelled.needsHuman, [{ number: 7, type: 'issue', agent: '' }]);
  assert.deepEqual(result.labelled.hold.map((h) => h.number).sort(), [33, 34]);
  const fix = result.overdue.find((o) => o.key === 'fix:31');
  assert.deepEqual([fix.kind, fix.number, fix.since], ['fix', 31, ago(3)]);
  const quiet = result.overdue.find((o) => o.key === 'quiet:grok/1');
  assert.deepEqual([quiet.number, quiet.agent], [null, 'grok/1']);
```

And a new test:

```js
test('pullState: first match wins', () => {
  const ctx = { reviews: [], checks: [], pushedAt: ago(1), gated: false };
  assert.equal(pullState(pull(1, ['swarm/pr', 'swarm/hold'], { draft: true }), ctx), 'draft');
  assert.equal(pullState(pull(1, ['swarm/pr', 'swarm/hold', 'swarm/needs-human']), ctx), 'needs_human');
  assert.equal(pullState(pull(1, ['swarm/pr', 'swarm/hold']), ctx), 'hold');
  assert.equal(pullState(pull(1, ['swarm/pr', 'conflicts-with-main']), ctx), 'needs_work');
  assert.equal(agentOf(pull(1, ['swarm/pr'], { user: { login: 'couchy-codex[bot]' } })), 'codex');
  assert.equal(agentOf(pull(1, ['swarm/pr'])), '');
});
```

If an existing fixture value makes one of the expected states above wrong under the precedence rule, keep the rule and correct the expectation, noting it in the commit.

- [ ] **Step 2:** Run `node --test agents.test.mjs`. Expected: FAIL on the new assertions.
- [ ] **Step 3:** Implement. `flag(section, key, line, { number = null, agent = '', since = null } = {})`; pass the values at each call site. Existing assertions (`gh.log`, `fixed.length`, overdue keys, desk body) must still pass unchanged.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `sweep: return each item's state, agent and timestamps beside the desk lines`.

---

### Task 3: the two counters and DESK_COMMENTS

**Files:**
- Modify: `sweep.mjs` (`deskBody`, `writeDesk`)
- Test: `agents.test.mjs`

**Interfaces:**
- Consumes: `result.labelled` from Task 2.
- Produces:
  - `readCounters(body)` → `{ needsHuman: {}, hold: {}, labelled: { needsHuman: [], hold: [] }, fresh: boolean }`. Parses `<!-- swarm-counters: {...} -->`; a missing or unparseable marker gives empty totals and `fresh: true`.
  - `countLabelled(prev, labelled)` → the next counters state (without `fresh`). Totals keys: `` `${type}|${agent}` `` under `needsHuman`, `agent` under `hold`. When `prev.fresh`, totals stay empty and only `labelled` number lists are recorded. Otherwise each number in `labelled` that is absent from `prev.labelled` adds 1 to its key. `labelled` in the result is the current number lists, sorted.
  - `deskBody(overdue, now, counters)`: appends `<!-- swarm-counters: ${JSON.stringify(counters)} -->` after the state marker when `counters` is given.
  - `writeDesk(gh, { desk, overdue, fixed, labelled, now, comments = true })` → the counters state it wrote (computed from `desk?.body` and `labelled`; on a dry run where no desk exists, the computed state is still returned). With `comments: false` it never calls `gh.comment`.

- [ ] **Step 1: Write the failing tests**

```js
test('counters: a newly labelled item adds one; the first run only records', () => {
  const now = { needsHuman: [{ number: 7, type: 'issue', agent: 'claude' }], hold: [{ number: 34, agent: '' }] };
  const first = countLabelled(readCounters('no marker here'), now);
  assert.deepEqual(first, { needsHuman: {}, hold: {}, labelled: { needsHuman: [7], hold: [34] } });
  const second = countLabelled(readCounters(deskBody([], NOW, first)), {
    needsHuman: [...now.needsHuman, { number: 9, type: 'pull', agent: 'codex' }], hold: [],
  });
  assert.deepEqual(second.needsHuman, { 'pull|codex': 1 });
  assert.deepEqual(second.labelled, { needsHuman: [7, 9], hold: [] });
  // #34 comes back on hold: counted again.
  const third = countLabelled(readCounters(deskBody([], NOW, second)), { needsHuman: now.needsHuman, hold: now.hold });
  assert.deepEqual(third.hold, { '': 1 });
  assert.equal(readCounters('<!-- swarm-counters: {oops -->').fresh, true);
});
test('desk: comments can be turned off; the body still carries state and counters', async () => {
  const gh = fake({ issues: [issue(90, ['swarm/desk'], { body: '' })] });
  const overdue = [{ section: 'Needs you', key: 'human:7', line: '#7 x' }];
  const counters = await writeDesk(gh, { desk: await gh.issue(90), overdue, fixed: ['f'], labelled: { needsHuman: [], hold: [] }, now: NOW, comments: false });
  assert.deepEqual(gh.log, ['edit 90']);
  assert.match((await gh.issue(90)).body, /agent-desk-state: \["human:7"\] -->\n<!-- swarm-counters: /);
  assert.deepEqual(counters.labelled, { needsHuman: [], hold: [] });
});
test('desk: created on the first run with a counters marker', async () => {
  const gh = fake();
  await writeDesk(gh, { desk: null, overdue: [], fixed: [], labelled: { needsHuman: [], hold: [] }, now: NOW });
  assert.match((await gh.issue(999)).body, /swarm-counters: /);
});
```

Update the two existing `writeDesk` call sites in the tests to pass `labelled` (from `result`, or empty lists).

- [ ] **Step 2:** Run `node --test agents.test.mjs`. Expected: FAIL, `countLabelled` is not exported.
- [ ] **Step 3:** Implement to the Interfaces above.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `sweep: count needs-human and hold labels across runs; DESK_COMMENTS=false stops the comments`.

---

### Task 4: the sweep pushes its metrics

**Files:**
- Modify: `github.mjs` (`client`), `sweep.mjs` (entry point, new `sweepMetrics`)
- Test: `agents.test.mjs`

**Interfaces:**
- Consumes: `registry`, `push` (Task 1); the Task 2 result; the counters state from `writeDesk` (Task 3).
- Produces:
  - `client(...)` gains `rateLimitRemaining()` → the number in the last response's `x-ratelimit-remaining` header, or `null` before any response or when the header is absent.
  - `sweepMetrics(reg, { result, counters, migrated, limits, now, startedAt, rateLimit })` fills the registry:
    - `swarm_agent_last_tick_timestamp_seconds{agent}` = `Date.parse(at) / 1000` per heartbeat
    - `swarm_pulls`, `swarm_issues` = 1 per row, `number` as a string
    - `swarm_lock_age_seconds`, `swarm_overdue_age_seconds` = `(now - Date.parse(since)) / 1000`, or 0 when `since` is `null`; `number` is `''` when `null`
    - `swarm_limit_seconds{limit}`: `claim` × 60; `ready`, `review`, `fix`, `hold`, `heartbeat` × 3600
    - `swarm_sweep_fixed{action}`: `lock_lapsed`, `lock_doubled` from `fixedCounts`; `label_migrated` = `migrated`; all three always set
    - `swarm_needs_human_total{type,agent}`, `swarm_hold_total{agent}` from `counters`; when a total map is empty, set one zero sample (`{type:'issue',agent:''}` and `{agent:''}`) so the series exists
    - `swarm_job_last_success_timestamp_seconds` = `now / 1000`; `swarm_job_duration_seconds` = `(now - startedAt) / 1000`; `swarm_github_rate_limit_remaining` only when `rateLimit !== null`
  - Entry point: reads `DESK_COMMENTS` (`'false'` turns comments off), calls `writeDesk`, then `sweepMetrics`, then `push(reg, { job: 'swarm_sweep', repository: gh.repo })` as the last step before the summary line.

- [ ] **Step 1: Write the failing tests**

```js
test('sweep metrics: one series per item, limits in seconds', () => {
  const reg = registry();
  sweepMetrics(reg, {
    result: {
      pulls: [{ number: 30, state: 'needs_review', agent: '' }], issues: [{ number: 3, state: 'locked', agent: 'claude' }],
      locks: [{ number: 3, agent: 'claude', type: 'issue', since: ago(1) }], heartbeats: [{ agent: 'grok/1', at: ago(20) }],
      overdue: [{ kind: 'quiet', number: null, agent: 'grok/1', since: ago(20) }, { kind: 'stages', number: 6, agent: '', since: null }],
      fixedCounts: { lock_lapsed: 2, lock_doubled: 1 },
    },
    counters: { needsHuman: { 'issue|claude': 3 }, hold: {} }, migrated: 0, limits: LIMITS, now: NOW, startedAt: NOW - 4000, rateLimit: 4321,
  });
  const out = reg.render();
  assert.match(out, /swarm_pulls\{number="30",state="needs_review",agent=""\} 1\n/);
  assert.match(out, /swarm_lock_age_seconds\{number="3",agent="claude",type="issue"\} 3600\n/);
  assert.match(out, /swarm_overdue_age_seconds\{number="",kind="quiet",agent="grok\/1"\} 72000\n/);
  assert.match(out, /swarm_overdue_age_seconds\{number="6",kind="stages",agent=""\} 0\n/);
  assert.match(out, /swarm_limit_seconds\{limit="claim"\} 5400\n/);
  assert.match(out, /swarm_limit_seconds\{limit="heartbeat"\} 28800\n/);
  assert.match(out, /swarm_sweep_fixed\{action="label_migrated"\} 0\n/);
  assert.match(out, /swarm_needs_human_total\{type="issue",agent="claude"\} 3\n/);
  assert.match(out, /swarm_hold_total\{agent=""\} 0\n/);
  assert.match(out, /swarm_job_duration_seconds 4\n/);
  assert.match(out, /swarm_github_rate_limit_remaining 4321\n/);
});
test('client: remembers the rate limit left', async () => {
  const gh = client({ token: 't', repo: 'a/b', fetchImpl: async () => ({ ok: true, status: 200, json: async () => [], headers: new Headers({ 'x-ratelimit-remaining': '4999' }) }) });
  assert.equal(gh.rateLimitRemaining(), null);
  await gh.labels();
  assert.equal(gh.rateLimitRemaining(), 4999);
});
```

The label order in the first test's expected lines follows each metric's `labels` list in `METRICS`; write that list in the spec table's order (`number`, `state`, `agent` and so on).

- [ ] **Step 2:** Run `node --test agents.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement. Existing `client` tests use fetch fakes without `headers`; read it as `res.headers?.get(...)`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS. Then `DRY_RUN=true GITHUB_REPOSITORY=getcouchy/couchy GITHUB_TOKEN=$(gh auth token) SWARM_PUSHGATEWAY_URL=http://127.0.0.1:1 node sweep.mjs` exits 0 with no push line (dry run).
- [ ] **Step 5:** Commit: `sweep: push its metrics when SWARM_PUSHGATEWAY_URL is set`.

---

### Task 5: reviewed pushes its metrics

**Files:**
- Modify: `reviewed.mjs`
- Test: `agents.test.mjs`

**Interfaces:**
- Consumes: `registry`, `push`; `gh.rateLimitRemaining()`.
- Produces: `status(gh, pr, opts)` → `{ line, state }` holding today's `report` logic; `report(gh, pr, opts)` → `(await status(...)).line`, so its callers and tests are untouched. Entry point: one `swarm_reviewed_pulls{number,state}` = 1 per PR handled, the three job metrics as in Task 4, `push(reg, { job: 'swarm_reviewed', repository: gh.repo })`. A run for one PR number (argument or `PR_NUMBER`) does not push: it would replace the group with one PR.

- [ ] **Step 1: Write the failing test**

```js
test('reviewed: status returns the state it posted', async () => {
  const gh = fake({ pulls: [pull(40, ['swarm/pr'])] });
  const { line, state } = await status(gh, (await gh.openPulls())[0]);
  assert.equal(state, 'pending');
  assert.match(line, /^#40: pending/);
});
```

- [ ] **Step 2:** Run `node --test agents.test.mjs`. Expected: FAIL, `status` is not exported.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `reviewed: push each pull request's status as a metric`.

---

### Task 6: chart value and the metrics reference

**Files:**
- Modify: `charts/swarm/values.yaml`, `charts/swarm/templates/cronjobs.yaml`, `charts/swarm/Chart.yaml` (version `0.2.0`), `charts/swarm/README.md`, `README.md`
- Create: `docs/metrics.md`
- Test: `chart.test.mjs`, `metrics.test.mjs`

**Interfaces:**
- Produces: value `metrics.pushgatewayUrl` (default `""`); when set, every CronJob's container gets `SWARM_PUSHGATEWAY_URL` with that value; when empty the variable is absent. `docs/metrics.md` has one table row per metric (name in backticks, type, labels, meaning), the `job` and `repository` labels explained, the counters' rules from the spec, and `DESK_COMMENTS`. The chart README gains a "Metrics" section linking to it and documenting the value; the values comment on `agent-sweep` lists `DESK_COMMENTS`.

- [ ] **Step 1: Write the failing tests**

```js
// chart.test.mjs
test('metrics.pushgatewayUrl reaches every job, and is absent by default', { skip }, () => {
  assert.doesNotMatch(render(repo).stdout, /SWARM_PUSHGATEWAY_URL/);
  const { stdout } = render(repo, 'metrics.pushgatewayUrl=http://pg:9091');
  assert.equal(stdout.match(/name: SWARM_PUSHGATEWAY_URL\s+value: "http:\/\/pg:9091"/g).length, 2);
});
// metrics.test.mjs
test('docs/metrics.md lists exactly the defined metrics', () => {
  const doc = readFileSync(new URL('./docs/metrics.md', import.meta.url), 'utf8');
  const JOBS = ['swarm_sweep', 'swarm_reviewed']; // the Pushgateway job names, which the doc also explains
  const named = new Set(doc.match(/swarm_[a-z_]+/g).filter((n) => !JOBS.includes(n)));
  assert.deepEqual([...named].sort(), Object.keys(METRICS).sort());
});
```

- [ ] **Step 2:** Run `npm test`. Expected: FAIL (both).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test` and `helm lint charts/swarm --set github.repository=acme/app`. Expected: PASS, 0 failed.
- [ ] **Step 5:** Commit: `charts/swarm 0.2.0: metrics.pushgatewayUrl, and docs/metrics.md`.

---

### Task 7: the dashboard

**Files:**
- Create: `charts/swarm/dashboards/swarm.json`
- Test: `metrics.test.mjs`

**Interfaces:**
- Consumes: metric names from `METRICS`.
- Produces: a Grafana dashboard, `uid: "swarm"`, `title: "Swarm"`, schema version matching what homelab's `couchy.json` uses (`/Users/calcifer/code/git.home/homelab/k8s/charts/grafana-dashboards/dashboards/couchy.json`). Template variables: `datasource` (type datasource, query `prometheus`, default uid `prometheus`), `loki` (type datasource, query `loki`, default uid `loki`), `repository` (`label_values(swarm_job_last_success_timestamp_seconds, repository)`), `agent` (`label_values(swarm_agent_last_tick_timestamp_seconds, agent)`, multi, include all), `namespace` (textbox, default `couchy-swarm`). Every Prometheus expression filters `repository="$repository"`; panels with an `agent` label filter `agent=~"$agent"`.
- Rows and their queries:
  1. Agents: `time() - swarm_agent_last_tick_timestamp_seconds` per agent (stat, thresholds from `swarm_limit_seconds{limit="heartbeat"}` drawn as a second query on a time series beside it); `count by (agent) (swarm_lock_age_seconds)`.
  2. Queue: `count(swarm_issues{state="claimable"}) or vector(0)` over time; table of `swarm_lock_age_seconds{type="issue"}`.
  3. Pull requests: `count by (state) (swarm_pulls)` stacked over time; table of `swarm_pulls` (instant) with columns number, state, agent; `swarm_reviewed_pulls` count by state.
  4. Overdue: table of `swarm_overdue_age_seconds` (instant), columns kind, number, agent, age (unit seconds); `number` has a data link `https://github.com/${repository}/issues/${__value.raw}` (GitHub redirects an issue URL to the PR).
  5. Handoffs: `sum by (agent) (increase(swarm_needs_human_total[$__range]))`, `sum by (agent) (increase(swarm_hold_total[$__range]))`.
  6. Housekeeping: `time() - swarm_job_last_success_timestamp_seconds` by `job`; `swarm_job_duration_seconds`; `swarm_github_rate_limit_remaining`; `swarm_sweep_fixed`; `sum(kube_job_status_failed{namespace="$namespace"})`.
  7. Events: Loki logs panel, `{namespace="$namespace"} |~ "^(fixed|overdue|renamed): "`.

- [ ] **Step 1: Write the failing test**

```js
test('dashboard: every swarm_ metric it queries is defined; none is left out', () => {
  const text = readFileSync(new URL('./charts/swarm/dashboards/swarm.json', import.meta.url), 'utf8');
  const dash = JSON.parse(text);
  assert.equal(dash.uid, 'swarm');
  const used = new Set(text.match(/swarm_[a-z_]+/g).filter((n) => !['swarm_sweep', 'swarm_reviewed'].includes(n)));
  for (const name of used) assert.ok(METRICS[name], `${name} is not defined`);
  for (const name of Object.keys(METRICS)) assert.ok(used.has(name), `${name} is on no panel`);
  assert.deepEqual(dash.templating.list.map((v) => v.name), ['datasource', 'loki', 'repository', 'agent', 'namespace']);
});
```

- [ ] **Step 2:** Run `node --test metrics.test.mjs`. Expected: FAIL, no such file.
- [ ] **Step 3:** Write the dashboard JSON. Panel types and layout are the implementer's.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `charts/swarm: a Grafana dashboard for the swarm's metrics`. Open the pull request for the branch (GitHub, `gh pr create`); its body says the sweep's reporting changes only behind `DESK_COMMENTS`, which the owner asked for.

---

### Task 8: ops turns the push on

Waits on: the swarm PR merged and chart 0.2.0 published to ghcr.

**Files (getcouchy/ops, a branch from `main`):**
- Modify: `k8s/charts/couchy-swarm/Chart.yaml` (dependency `swarm` to `0.2.0`; chart `version` to `0.3.0`), `k8s/charts/couchy-swarm/Chart.lock` (via `helm dependency update k8s/charts/couchy-swarm`), `k8s/charts/couchy-swarm/values.yaml`, `k8s/charts/couchy-swarm/README.md`

- [ ] **Step 1:** Under `swarm:` in values add

```yaml
  # The homelab's Pushgateway (homelab, k8s/values/prometheus.yaml). The sweep
  # and reviewed push their metrics there; getcouchy/swarm's docs/metrics.md
  # lists them.
  metrics:
    pushgatewayUrl: http://prometheus-prometheus-pushgateway.homelab.svc:9091
```

- [ ] **Step 2:** README: a "Metrics" section naming the dashboard and where it is loaded from.
- [ ] **Step 3:** Run `helm dependency build k8s/charts/couchy-swarm && helm template couchy-swarm k8s/charts/couchy-swarm | grep -c SWARM_PUSHGATEWAY_URL`. Expected: `6`.
- [ ] **Step 4:** Commit, open the PR. After it merges and deploys, verify on the cluster (the owner's shell; `KUBECONFIG` must be a path):
  `kubectl -n couchy-swarm create job --from=cronjob/agent-sweep sweep-now`, then in Prometheus `swarm_job_last_success_timestamp_seconds`. Expected: two series, `job="swarm_sweep"` and `job="swarm_reviewed"`, each with `repository="getcouchy/couchy"`. If the label arrives as `exported_job`, the Pushgateway scrape job lacks `honor_labels: true`; fix that in homelab's `k8s/values/prometheus.yaml` before Task 9.

---

### Task 9: homelab loads the dashboard and alerts

Waits on: Task 8 verified.

**Files (homelab on git.home; PR with `tea`, not `gh`):**
- Create: `k8s/charts/grafana-dashboards/dashboards/swarm.json`, a copy of swarm's `charts/swarm/dashboards/swarm.json`
- Modify: `k8s/charts/grafana-dashboards/Chart.yaml` (version `0.1.23`; description names swarm.json and where its source is), `k8s/charts/grafana-alerting/files/rules.yaml` and that chart's version

- [ ] **Step 1:** Copy the dashboard; bump the chart.
- [ ] **Step 2:** Add three rules, following the file's existing rule shape and its Pushover routing:
  - agent quiet: `time() - swarm_agent_last_tick_timestamp_seconds > on (repository) group_left swarm_limit_seconds{limit="heartbeat"}`, for 10m
  - sweep stale: `time() - swarm_job_last_success_timestamp_seconds{job="swarm_sweep"} > 1800`, `noDataState: Alerting`
  - needs you: `count by (repository) (swarm_overdue_age_seconds{kind="human"}) > 0`, for 10m
- [ ] **Step 3:** Run `helm template` on both charts. Expected: renders; `dashboard-swarm` ConfigMap present.
- [ ] **Step 4:** Commit, push, `tea pr create --base main --head <branch> ...`. After deploy, open the Swarm dashboard in Grafana and check each row shows data.

---

### Task 10: ops turns the desk comments off

Waits on: the owner confirming the dashboard and alerts replace the comments.

**Files (getcouchy/ops):** `k8s/charts/couchy-swarm/values.yaml`, `README.md`, chart `version`

- [ ] **Step 1:** Under `swarm.jobs.agent-sweep` add `env: { DESK_COMMENTS: "false" }` with a comment saying the dashboard and Grafana's alerts carry what the comments did.
- [ ] **Step 2:** `helm template ... | grep -A1 DESK_COMMENTS`. Expected: `value: "false"` on agent-sweep only.
- [ ] **Step 3:** Commit, open the PR.
