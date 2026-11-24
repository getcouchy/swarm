// node --test
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const eventsFile = () => join(mkdtempSync(join(tmpdir(), 'timing-')), 'events.jsonl');
const bare = { PATH: process.env.PATH, HOME: process.env.HOME, AGENT_NO_SYNC: '1', AGENT_NAME: 'codex' };

test('a command leaves a line when it starts and one when it returns, whatever it returns', () => {
  const file = eventsFile();
  // No GitHub token: it exits 2 before it does anything, and that is a return.
  const r = spawnSync(process.execPath, ['agent.mjs', 'next', '--look'], { cwd: root, env: { ...bare, TICK_EVENTS_FILE: file }, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  const [start, end, ...rest] = lines(file);
  assert.deepEqual(rest, []);
  assert.deepEqual([start.v, start.cmd, start.of], [1, 'start', 'next']);
  assert.deepEqual([end.v, end.cmd, end.of, end.id, end.rc], [1, 'end', 'next', start.id, 2]);
  assert.ok(end.seconds >= 0 && end.seconds < 30, `${end.seconds}`);
  assert.ok(Math.abs(Date.parse(start.at) - Date.now()) < 60_000, start.at);
});

test('a copy that is handed the command writes nothing of its own', () => {
  const file = eventsFile();
  spawnSync(process.execPath, ['agent.mjs', 'next', '--look'], { cwd: root, env: { ...bare, TICK_EVENTS_FILE: file, AGENT_COMMAND_ID: 'the-parents' } });
  assert.throws(() => lines(file), /ENOENT/);
});

test('a command that hangs and is killed leaves a start with no end', async () => {
  const file = eventsFile();
  const hang = `import { timeCommand } from '${join(root, 'lib/timing.mjs')}'; timeCommand('${file}', 'more'); setInterval(() => {}, 1000); console.log('up');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', hang], { env: bare });
  await new Promise((done) => child.stdout.once('data', done));
  child.kill('SIGTERM');
  await new Promise((done) => child.once('exit', done));
  assert.deepEqual(lines(file).map((l) => [l.cmd, l.of]), [['start', 'more']]);
});

test('nothing is written without a file, and a file that cannot be written costs the command nothing', () => {
  for (const file of ['', '/nowhere/events.jsonl']) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { timeCommand } from '${join(root, 'lib/timing.mjs')}'; timeCommand('${file}', 'next');`], { env: bare, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
});
