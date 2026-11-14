// Renders charts/swarm with helm and checks what comes out. Skipped where
// helm isn't installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const chart = fileURLToPath(new URL('./charts/swarm', import.meta.url));
const skip = spawnSync('helm', ['version'], { encoding: 'utf8' }).status === 0 ? false : 'helm is not installed';

function render(...sets) {
  const args = ['template', 't', chart, ...sets.flatMap((s) => ['--set', s])];
  return spawnSync('helm', args, { encoding: 'utf8' });
}

function cronJobNames(stdout) {
  return stdout
    .split(/^---$/m)
    .filter((doc) => /^kind: CronJob$/m.test(doc))
    .map((doc) => doc.match(/^metadata:\n {2}name: (.+)$/m)[1])
    .sort();
}

const repo = 'github.repository=acme/app';

test('refuses to render without github.repository', { skip }, () => {
  const r = render();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /github\.repository/);
});

test('built-in jobs run swarm scripts against the given repository', { skip }, () => {
  const { stdout, stderr } = render(repo);
  assert.deepEqual(cronJobNames(stdout), ['agent-reviewed', 'agent-sweep'], stderr);
  assert.match(stdout, /name: GITHUB_REPOSITORY\s+value: "acme\/app"/);
  assert.match(stdout, /name: SOURCE_REPOSITORY\s+value: "getcouchy\/swarm"/);
  assert.match(stdout, /name: swarm-github-app, key: app-id/);
  assert.doesNotMatch(stdout, /couchy-swarm|REVIEWED_CREATOR/);
});

test('enabled=false drops a built-in job', { skip }, () => {
  const { stdout } = render(repo, 'jobs.agent-sweep.enabled=false');
  assert.deepEqual(cronJobNames(stdout), ['agent-reviewed']);
});

test("a job's ref overrides github.ref", { skip }, () => {
  const { stdout } = render(repo, 'jobs.agent-sweep.enabled=false', 'jobs.agent-reviewed.ref=v1');
  assert.match(stdout, /name: SOURCE_REF\s+value: "v1"/);
  assert.doesNotMatch(stdout, /name: SOURCE_REF\s+value: "main"/);
});

test('an added job without source runs from github.repository', { skip }, () => {
  const { stdout } = render(repo, 'jobs.agent-sweep.enabled=false', 'jobs.agent-reviewed.enabled=false',
    'jobs.mine.schedule=0 * * * *', 'jobs.mine.run={tools/x.mjs}');
  assert.deepEqual(cronJobNames(stdout), ['mine']);
  assert.match(stdout, /name: SOURCE_REPOSITORY\s+value: "acme\/app"/);
});

test('secretEnv needs extraSecretName', { skip }, () => {
  const r = render(repo, 'jobs.agent-sweep.secretEnv.K=K');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /extraSecretName/);
});

test('github.ref does not move the built-in jobs off main', { skip }, () => {
  const { stdout } = render(repo, 'github.ref=trunk');
  assert.match(stdout, /name: SOURCE_REF\s+value: "main"/);
  assert.doesNotMatch(stdout, /name: SOURCE_REF\s+value: "trunk"/);
});

test('a job needs a schedule and a script', { skip }, () => {
  const noRun = render(repo, 'jobs.mine.schedule=0 * * * *');
  assert.notEqual(noRun.status, 0);
  assert.match(noRun.stderr, /jobs\.mine\.run/);
  const noSchedule = render(repo, 'jobs.mine.run={x.mjs}');
  assert.notEqual(noSchedule.status, 0);
  assert.match(noSchedule.stderr, /jobs\.mine\.schedule/);
});

test('metrics.pushgatewayUrl reaches every job, and is absent by default', { skip }, () => {
  assert.doesNotMatch(render(repo).stdout, /SWARM_PUSHGATEWAY_URL/);
  const { stdout } = render(repo, 'metrics.pushgatewayUrl=http://pg:9091');
  assert.equal(stdout.match(/name: SWARM_PUSHGATEWAY_URL\s+value: "http:\/\/pg:9091"/g).length, 2);
});

test('script arguments render as strings', { skip }, () => {
  const { stdout } = render(repo, 'jobs.mine.schedule=0 * * * *', 'jobs.mine.run={x.mjs,--n,5}');
  assert.match(stdout, /- "x\.mjs"\n\s+- "--n"\n\s+- "5"/);
});
