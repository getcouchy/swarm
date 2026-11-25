// The protocol's documents, rendered from the settings (config.mjs). An agent
// follows what PROTOCOL.md says and the tools enforce what the settings say,
// so the documents are written once as templates (templates/) and every name
// and number in them is filled in from the same settings the rules read.
//
// A template is Markdown with:
//   {{name}}                      a value from vars() below; an unknown name is an error
//   {{#if name}}…{{/if}}          kept when the value is set; {{#unless name}}…{{/unless}} when it isn't
//   {{note:slot}}                 this deployment's own words for that place: notes/<slot>.md beside the
//                                 settings file, or nothing. Alone on a line it is a paragraph, and the
//                                 line goes when there is no note; inside a sentence it is inlined.
// Blocks don't nest.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LABEL_NAMES, configPath, toolsRoot } from './config.mjs';

/** The documents that are rendered: templates/<name> to <name> at the root. */
export const DOCUMENTS = ['PROTOCOL.md', 'TICK.md', 'ARCHITECT.md'];

const code = (s) => `\`${s}\``;
/** `a`, `b` and `c`, each as code. */
const listed = (items, last = 'and') => {
  const all = items.map(code);
  return all.length < 2 ? all.join('') : `${all.slice(0, -1).join(', ')} ${last} ${all.at(-1)}`;
};

/** Every value a template can name, from the settings. */
export function vars(cfg) {
  const home = cfg.repos[0] ?? null;
  const ns = cfg.labels.namespace;
  const teams = new Map(); // team key -> its repositories, in the order listed
  for (const [repo, key] of Object.entries(cfg.linear.teams)) teams.set(key, [...(teams.get(key) ?? []), repo]);
  const key = (home && cfg.linear.teams[home]) || [...teams.keys()][0] || 'ABC';
  const aliases = Object.entries(cfg.labels.aliases);
  const out = {
    name: cfg.name,
    owner: cfg.owner,
    // The tools' repository, as a name and as the address a sandbox clones.
    tools: cfg.toolsRepo ?? "the swarm's tools repository",
    'tools.url': cfg.toolsRepo ? `https://github.com/${cfg.toolsRepo}` : '<the address of the swarm\'s tools repository>',
    org: home ? home.split('/')[0] : null,
    home: home ?? '<the home repository>',
    // A second repository, for the examples that name a pull request outside the home repository.
    other: cfg.repos[1] ?? 'owner/other',
    repos: cfg.repos.length ? listed(cfg.repos) : null,
    design: cfg.designRepo ?? 'the design repository (the settings name none: `designRepo`)',
    'design.name': cfg.designRepo ? cfg.designRepo.split('/')[1] : 'the design repository',
    base: cfg.baseBranch,
    ns,
    status: cfg.review.status,
    conflict: cfg.labels.conflict,
    'merge.method': cfg.merge.method,
    'qa.labels': cfg.qa.labels.length ? listed(cfg.qa.labels, 'or') : null,
    'qa.skipLabels': cfg.qa.skipLabels.length ? listed(cfg.qa.skipLabels, 'and') : null,
    'tick.minutes': cfg.tick.minutes,
    'tick.ceiling': cfg.tick.ceiling,
    'claim.minutes': cfg.sweep.claimMinutes,
    // An agent's GitHub App is <bot><name>; its sandbox's variables start with <BOT>.
    bot: cfg.bots.prefix,
    BOT: cfg.bots.env,
    KEY: key,
    'g.agent': cfg.linear.groups.agent,
    'g.protocol': cfg.linear.groups.protocol,
    'g.repo': cfg.linear.groups.repo,
    'state.qa': cfg.linear.states.qa,
    'state.needsHuman': cfg.linear.states.needsHuman,
    'linear.url': cfg.linear.workspace ? `https://linear.app/${cfg.linear.workspace}` : null,
    'linear.workspace': cfg.linear.workspace,
    // "The work for `a/b` and `a/c` is in team `ABC`.", a sentence for each team.
    teams: teams.size ? [...teams].map(([k, repos]) => `The work for ${listed(repos)} is in team ${code(k)}.`).join(' ') : null,
    // "`merge/hold` for `swarm/hold`, …": what labels were called before.
    aliases: aliases.length ? aliases.map(([old, k]) => `${code(old.endsWith('/') ? `${old}<name>` : old)} for ${code(old.endsWith('/') ? `${cfg.label[k]}<name>` : cfg.label[k])}`).join(', ') : null,
  };
  for (const k of Object.keys(LABEL_NAMES)) {
    out[`l.${k}`] = cfg.label[k]; // swarm/needs-human
    out[`c.${k}`] = cfg.label[k].slice(ns.length); // needs-human: what Linear calls it inside its group
  }
  return out;
}

/** This deployment's note for a slot, trimmed; '' when it has none. */
export function noteReader(cfg) {
  const dir = configPath(cfg, 'notes');
  return (slot) => {
    const file = dir && join(dir, `${slot}.md`);
    return file && existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  };
}

/** `template` with its blocks, notes and values filled in. */
export function render(template, values, note = () => '') {
  const value = (name) => {
    if (!(name in values)) throw new Error(`{{${name}}}: no such value (lib/render.mjs, vars)`);
    return values[name];
  };
  const keep = (kind, name) => (kind === 'if') === (value(name) !== null && value(name) !== '');
  return template
    // A block whose markers have lines of their own takes those lines with it.
    .replace(/^\{\{#(if|unless) ([\w.]+)\}\}\n([\s\S]*?)^\{\{\/\1\}\}\n/gm, (_, kind, name, body) => (keep(kind, name) ? body : ''))
    .replace(/\{\{#(if|unless) ([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, kind, name, body) => (keep(kind, name) ? body : ''))
    // A note alone on its line is a paragraph: with no note, the line and the blank one after it go.
    .replace(/^\{\{note:([\w-]+)\}\}\n(\n?)/gm, (_, slot, blank) => (note(slot) ? `${note(slot)}\n${blank}` : ''))
    .replace(/\{\{note:([\w-]+)\}\}/g, (_, slot) => note(slot))
    .replace(/\{\{([\w.]+)\}\}/g, (_, name) => {
      const v = value(name);
      if (v === null) throw new Error(`{{${name}}} is not set in the settings; put it inside {{#if ${name}}}`);
      return String(v);
    });
}

const banner = (name) => `<!-- Rendered from templates/${name} with the settings (swarm.config.json). Don't edit this file: change the template, or the settings, and run \`npm run docs\`. -->\n\n`;

/** One document, rendered for `cfg`, as it is written to the root. */
export function renderDocument(name, cfg, root = toolsRoot) {
  const template = readFileSync(join(root, 'templates', name), 'utf8');
  try {
    return banner(name) + render(template, vars(cfg), noteReader(cfg));
  } catch (e) {
    throw new Error(`templates/${name}: ${e.message}`);
  }
}
