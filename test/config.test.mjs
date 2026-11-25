// node --test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, LABEL_NAMES, configFile, loadConfig, resolveConfig, toolsRoot } from '../lib/config.mjs';
import { DOCUMENTS, render, renderDocument, vars } from '../lib/render.mjs';
import { ROLES, roleOf } from '../lib/rules.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const acme = {
  name: 'Acme',
  toolsRepo: 'acme/swarm',
  repos: ['acme/app', 'acme/api'],
  baseBranch: 'trunk',
  labels: { namespace: 'bots/', names: { hold: 'wait' }, aliases: { 'on-hold': 'hold', 'bot/': 'agent' } },
  qa: { labels: ['ui'], skipLabels: [] },
  tick: { minutes: 30, ceiling: 60 },
  sweep: { claimMinutes: 120 },
  bots: { prefix: 'acme-', org: 'acme', env: 'ACME' },
  linear: { teams: { 'acme/app': 'APP', 'acme/api': 'API' }, states: { qa: 'QA' } },
};

test('config: with no file, the protocol\'s defaults and no repository', () => {
  const cfg = resolveConfig();
  assert.equal(cfg.label.needsHuman, 'swarm/needs-human');
  assert.equal(cfg.label.agent, 'swarm/agent/');
  assert.deepEqual(Object.keys(cfg.label), Object.keys(LABEL_NAMES));
  assert.deepEqual(cfg.linear.groups, { agent: 'swarm-agent', protocol: 'swarm', repo: 'repo' });
  assert.deepEqual(cfg.repos, []);
  assert.equal(cfg.bots.prefix, null, 'no bot counts as an agent until a prefix is set');
  assert.deepEqual(cfg.tick, { minutes: 20, ceiling: 45 });
  assert.equal(DEFAULTS.linear.groups.agent, null, 'resolving never changes the defaults');
});

test('config: a deployment renames the namespace and a label, and the rest follows', () => {
  const cfg = resolveConfig(acme);
  assert.equal(cfg.label.hold, 'bots/wait');
  assert.equal(cfg.label.needsHuman, 'bots/needs-human');
  assert.equal(cfg.label.agent, 'bots/agent/');
  assert.deepEqual(cfg.linear.groups, { agent: 'bots-agent', protocol: 'bots', repo: 'repo' });
  assert.equal(cfg.sweep.claimMinutes, 120);
  assert.equal(cfg.sweep.readyHours, 4, 'a setting left out keeps its default');
  assert.equal(cfg.linear.states.needsHuman, 'Needs Human');
});

test('config: a mistake is named, not ignored', () => {
  const bad = (given, re) => assert.throws(() => resolveConfig(given), re);
  bad({ lables: {} }, /lables: no such setting/);
  bad({ tick: { minuets: 5 } }, /tick\.minuets: no such setting/);
  bad({ labels: { namespace: 'Swarm' } }, /labels\.namespace/);
  bad({ labels: { names: { hodl: 'x' } } }, /labels\.names\.hodl: no such label/);
  bad({ labels: { names: { agent: 'bot' } } }, /prefix and must end with a slash/);
  bad({ labels: { names: { hold: 'qa' } } }, /two labels the name swarm\/qa/);
  bad({ labels: { aliases: { old: 'nothing' } } }, /no such label "nothing"/);
  bad({ repos: ['app'] }, /repos\[0\] must be owner\/name/);
  bad({ tick: { minutes: 50, ceiling: 45 } }, /tick\.ceiling/);
  bad({ bots: { prefix: 'Acme' } }, /bots\.prefix/);
  bad({ merge: { method: 'yolo' } }, /merge\.method/);
});

test('config: SWARM_CONFIG names the file, and a file that is named but missing is an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-config-'));
  const file = join(dir, 'mine.json');
  writeFileSync(file, JSON.stringify(acme));
  assert.equal(configFile({ SWARM_CONFIG: file }), file);
  assert.equal(configFile({}, dir), null, 'no file beside the tools: the defaults');
  writeFileSync(join(dir, 'swarm.config.json'), '{}');
  assert.equal(configFile({}, dir), join(dir, 'swarm.config.json'));
  const cfg = loadConfig(file);
  assert.equal(cfg.dir, dir);
  assert.equal(cfg.label.hold, 'bots/wait');
  assert.throws(() => loadConfig(join(dir, 'gone.json')), /no such file/);
  writeFileSync(file, '{ not json');
  assert.throws(() => loadConfig(file), /mine\.json/);
});

test('config: the tools read another deployment\'s settings', () => {
  // The rules take their names at import, so another deployment is another process.
  const dir = mkdtempSync(join(tmpdir(), 'swarm-config-'));
  const file = join(dir, 'acme.json');
  writeFileSync(file, JSON.stringify(acme));
  const script = `
    const r = await import(${JSON.stringify(join(root, 'lib/rules.mjs'))});
    const l = await import(${JSON.stringify(join(root, 'lib/linear.mjs'))});
    const pr = (labels) => ({ labels: labels.map((name) => ({ name })) });
    console.log(JSON.stringify({
      hold: r.HOLD, lock: r.AGENT_PREFIX, base: r.BASE_BRANCH,
      holders: r.providers(pr(['bots/agent/codex', 'bot/claude', 'swarm/agent/grok'])),
      old: r.canonical('on-hold'),
      bot: [r.agentFromLogin('acme-codex[bot]'), r.agentFromLogin('couchy-codex[bot]')],
      qa: [r.needsQA(pr(['ui'])), r.needsQA(pr([]))],
      place: l.linearPlace('bots/agent/codex'), name: l.protocolName({ name: 'needs-sim', parent: { name: 'bots' } }),
      teams: l.DEFAULT_TEAMS,
    }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, SWARM_CONFIG: file }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    hold: 'bots/wait', lock: 'bots/agent/', base: 'trunk',
    holders: ['claude', 'codex'], // the old prefix is read; another deployment's label is not a lock
    old: 'bots/wait',
    bot: ['codex', null],
    qa: [true, true], // no label skips QA here, so everything is walked
    place: { group: 'bots-agent', child: 'codex' }, name: 'bots/needs/sim',
    teams: 'acme/app=APP,acme/api=API',
  });
});

test('roles: general, builder, pm and architect, under the names they had before too', () => {
  assert.deepEqual(ROLES, ['general', 'builder', 'pm', 'architect']);
  for (const [asked, role] of [[undefined, 'general'], ['', 'general'], ['all', 'general'], ['general', 'general'], ['focus', 'builder'], ['builder', 'builder'],
    ['task-breakdown', 'pm'], ['shape', 'pm'], ['pm', 'pm'], ['architect', 'architect']]) {
    assert.equal(roleOf(asked), role, String(asked));
  }
  assert.equal(roleOf('architekt'), null, 'a role that isn\'t one is not a general tick');
  const run = spawnSync(process.execPath, ['agent.mjs', 'next', '--look'], { cwd: root, env: { PATH: process.env.PATH, AGENT_NAME: 'codex', AGENT_ROLE: 'architekt', AGENT_NO_SYNC: '1' }, encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /AGENT_ROLE=architekt: no such role.*general, builder, pm, architect/);
});

test('render: values, blocks and notes', () => {
  const values = { a: 'one', none: null, empty: '' };
  const note = (slot) => ({ here: 'A note.', inline: ', as noted' }[slot] ?? '');
  assert.equal(render('x {{a}} y', values), 'x one y');
  assert.equal(render('x{{#if a}} has {{a}}{{/if}}{{#unless a}} lacks{{/unless}}.', values), 'x has one.');
  assert.equal(render('x{{#if none}} has{{/if}}{{#unless none}} lacks{{/unless}}.', values), 'x lacks.');
  assert.equal(render('top\n{{#if none}}\ngone\n{{/if}}\nbottom\n', values), 'top\nbottom\n');
  assert.equal(render('top\n{{#if a}}\nkept {{a}}\n{{/if}}\nbottom\n', values), 'top\nkept one\nbottom\n');
  assert.equal(render('p1\n\n{{note:here}}\n\np2\n', values, note), 'p1\n\nA note.\n\np2\n');
  assert.equal(render('p1\n\n{{note:nothing}}\n\np2\n', values, note), 'p1\n\np2\n', 'a slot with no note leaves no gap');
  assert.equal(render('checks{{note:inline}};', values, note), 'checks, as noted;');
  assert.equal(render('checks{{note:nothing}};', values, note), 'checks;');
  assert.throws(() => render('{{typo}}', values), /\{\{typo\}\}: no such value/);
  assert.throws(() => render('{{none}}', values), /not set in the settings/);
});

test('render: every document renders for the defaults and for another deployment, in its own names', () => {
  for (const doc of DOCUMENTS) {
    const plain = renderDocument(doc, resolveConfig());
    assert.doesNotMatch(plain, /\{\{|\}\}/, `${doc}: a token left over`);
    assert.doesNotMatch(plain, /couchy/i, `${doc}: the defaults name no deployment`);
    const theirs = renderDocument(doc, resolveConfig({ ...acme, notes: null }));
    assert.doesNotMatch(theirs, /\{\{|\}\}/, `${doc}: a token left over`);
    assert.doesNotMatch(theirs, /couchy|swarm\/(?!agent\.mjs|bots\.mjs|PROTOCOL\.md)|`swarm`|swarm-agent/i, `${doc}: another deployment's names`);
  }
  const theirs = renderDocument('PROTOCOL.md', resolveConfig({ ...acme, notes: null }));
  assert.match(theirs, /`bots\/wait` \| holds a PR's merge/);
  assert.match(theirs, /`bots\/agent\/<name>` \| that agent is working/);
  assert.match(theirs, /\(`AGENT_TICK_MINUTES`, 30 by default\)/);
  assert.match(theirs, /The work for `acme\/app` is in team `APP`\. The work for `acme\/api` is in team `API`\./);
  assert.match(theirs, /QA when it carries `bots\/qa`, `ui`; the settings\nname no label that skips it, so every item does\./);
  assert.match(theirs, /`on-hold` for `bots\/wait`, `bot\/<name>` for `bots\/agent\/<name>`/);
  assert.match(theirs, /`origin\/trunk`/);
  assert.match(theirs, /off after 120 minutes/);
  assert.deepEqual(Object.keys(vars(resolveConfig())).filter((k) => k.startsWith('l.')).length, Object.keys(LABEL_NAMES).length);
});

test('render: the documents in this repository are what its templates and settings render to', () => {
  // An agent reads PROTOCOL.md as committed; the tools read the settings. This is what keeps the two the same.
  const cfg = loadConfig(configFile({}, toolsRoot));
  for (const doc of DOCUMENTS) {
    assert.equal(readFileSync(join(root, doc), 'utf8'), renderDocument(doc, cfg), `${doc} is stale: run npm run docs`);
  }
});
