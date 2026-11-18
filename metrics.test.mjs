// node --test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { METRICS, push, pushRun, registry } from './metrics.mjs';

test('docs/metrics.md lists exactly the defined metrics', () => {
  const doc = readFileSync(new URL('./docs/metrics.md', import.meta.url), 'utf8');
  const JOBS = ['swarm_sweep', 'swarm_reviewed']; // the Pushgateway job names, which the doc also explains
  const named = new Set(doc.match(/swarm_[a-z_]+/g).filter((n) => !JOBS.includes(n)));
  assert.deepEqual([...named].sort(), Object.keys(METRICS).sort());
});

test('dashboard: every swarm_ metric it queries is defined; none is left out', () => {
  const text = readFileSync(new URL('./charts/swarm/dashboards/swarm.json', import.meta.url), 'utf8');
  const dash = JSON.parse(text);
  assert.equal(dash.uid, 'swarm');
  const used = new Set(text.match(/swarm_[a-z_]+/g).filter((n) => !['swarm_sweep', 'swarm_reviewed'].includes(n)));
  for (const name of used) assert.ok(METRICS[name], `${name} is not defined`);
  for (const name of Object.keys(METRICS)) assert.ok(used.has(name), `${name} is on no panel`);
  assert.deepEqual(dash.templating.list.map((v) => v.name), ['prometheus', 'loki', 'repository', 'agent', 'namespace', 'item', 'tracker']);
  // Every Prometheus query is narrowed to the chosen repository, or it would mix repositories.
  const exprs = dash.panels.flatMap((p) => p.targets ?? []).filter((t) => t.datasource.type === 'prometheus').map((t) => t.expr);
  for (const expr of exprs.filter((e) => e.includes('swarm_'))) assert.match(expr, /repository="\$repository"/, expr);
});

test('dashboard: the agent filter lists every agent a series names; datasources default to the usual uids', () => {
  const dash = JSON.parse(readFileSync(new URL('./charts/swarm/dashboards/swarm.json', import.meta.url), 'utf8'));
  const variable = (name) => dash.templating.list.find((v) => v.name === name);
  // Heartbeat ids alone would miss an agent known only by its lock or its bot.
  assert.match(variable('agent').query.query, /__name__=~"swarm_\.\+"/);
  assert.equal(variable('prometheus').current.value, 'prometheus');
  assert.equal(variable('loki').current.value, 'loki');
});

test('pushRun: a registry that can not be filled costs a logged line, not the run', async () => {
  const lines = [];
  const calls = [];
  const opts = { job: 'j', repository: 'a/b', url: 'http://pg', dryRun: false, log: (l) => lines.push(l), fetchImpl: async (u) => { calls.push(u); return { ok: true, status: 200 }; } };
  assert.equal(await pushRun({ ...opts, fill: (reg) => reg.set('swarm_nope', {}, 1) }), false);
  assert.deepEqual([lines.length, calls.length], [1, 0]);
  assert.equal(await pushRun({ ...opts, fill: (reg) => reg.set('swarm_job_duration_seconds', {}, 2) }), true);
  assert.equal(calls.length, 1);
});

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
