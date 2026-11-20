// The commands a shaping tick works a work item with (PROTOCOL.md, "Shaping
// ticks"), and the two any tick reads one with: `show` and `images`. Each gets
// the work item's tracker (workitems.mjs) and returns what agent.mjs prints.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { AGENT_PREFIX, DESIGN, GROOM, NS, SHAPED, labelNames, providers } from './rules.mjs';

export const SHAPE_COMMANDS = ['show', 'images', 'describe', 'create', 'blocked-by', 'labels', 'attach', 'shaped'];

export const SHAPE_USAGE = [
  'show <key>',
  'images <key> [--dir=<path>]',
  'describe <key> <file.md>',
  'create <parent key> <file.md> [--title=<title>] [--labels=a,b] [--blocked-by=<keys>] [--priority=<p>]',
  'blocked-by <key> <keys>',
  'labels <key> +<name> -<name>…',
  'attach <key> <file>…',
  'shaped <key> "<summary>"',
].join(' | ');

/** A command line a shaping command can't run: commands.mjs turns it into a UsageError. */
export class ShapeUsage extends Error {}

const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.html': 'text/html', '.md': 'text/markdown', '.txt': 'text/plain',
};
const EXT = Object.fromEntries(Object.entries(TYPES).map(([e, t]) => [t, e]));
const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

const opt = (args, name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const positional = (args) => args.filter((a) => !a.startsWith('--'));
const keys = (text) => (text ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The title and body of a Markdown file: `--title`, else its first line when
 * that is a `# ` heading (which then leaves the body).
 */
export function titled(md, title) {
  const [first, ...rest] = md.split('\n');
  const h = /^#\s+(.+)$/.exec(first ?? '');
  if (title) return { title, body: md };
  if (!h) throw new ShapeUsage('create needs --title, or a file whose first line is "# <title>".');
  return { title: h[1].trim(), body: rest.join('\n').replace(/^\n+/, '') };
}

/**
 * Run one of SHAPE_COMMANDS. ctx: { client (the work item's tracker), me,
 * readFile, writeFile, mkdir, dir (where images go) }.
 */
export async function shapeCommand(cmd, args, { client, me, readFile = readFileSync, writeFile = writeFileSync, mkdir = (d) => mkdirSync(d, { recursive: true }), dir = tmpdir() }) {
  const [key, ...rest] = positional(args);
  if (!key) throw new ShapeUsage(`Usage: agent.mjs ${SHAPE_USAGE.split(' | ').find((u) => u.startsWith(cmd))}`);
  const item = await client.issue(key);
  if (!item) throw new ShapeUsage(`${key}: no such work item.`);
  const holding = () => {
    if (!providers(item).includes(me)) throw new ShapeUsage(`${cmd} changes ${key}: claim it first (agent.mjs claim ${key}).`);
  };

  if (cmd === 'show') {
    const comments = await client.comments(key);
    const children = await client.subIssues(key, 1);
    return {
      key: item.key, title: item.title, url: item.html_url, stage: item.stage, priority: item.priority,
      labels: labelNames(item), parent: item.parent, blockers: await client.blockers(item),
      description: item.body,
      attachments: await client.attachments(key),
      links: (await client.links?.(key)) ?? [],
      children: children.map((k) => ({ key: k, title: client.seen?.(k)?.title ?? null })),
      comments: comments.map((c) => ({ at: c.created_at, text: c.body })),
      then: `Images in the description and attachments: agent.mjs images ${key}`,
    };
  }

  if (cmd === 'images') {
    const to = opt(args, 'dir') ?? join(dir, 'swarm-images', key);
    mkdir(to);
    const files = [];
    const done = new Set();
    const save = async (url, name, source) => {
      if (done.has(url)) return;
      done.add(url);
      try {
        const { type, bytes } = await client.download(url);
        const ext = extname(name) || EXT[type.split(';')[0]] || '';
        const path = join(to, `${String(files.length + 1).padStart(2, '0')}-${basename(name, extname(name)).replace(/[^\w.-]+/g, '-')}${ext}`);
        writeFile(path, bytes);
        files.push({ from: url, source, path });
      } catch (e) {
        files.push({ from: url, source, error: e.message });
      }
    };
    // An image's alt text is its file name when it has one (`![board.png](…)`), as an upload's is.
    const nameOf = (alt, url) => (extname(alt) ? alt : basename(new URL(url, 'https://x/').pathname) || 'image');
    for (const [, alt, url] of item.body.matchAll(IMAGE)) await save(url, nameOf(alt, url), 'description');
    // The owner's feedback (a failed QA, say) often carries a screenshot.
    for (const c of await client.comments(key)) {
      for (const [, alt, url] of (c.body ?? '').matchAll(IMAGE)) await save(url, nameOf(alt, url), `comment ${c.created_at}`);
    }
    for (const a of await client.attachments(key)) await save(await client.attachmentUrl(key, a.id), a.name ?? a.id, 'attachment');
    return { key, dir: to, files, then: 'Read each path to see it.' };
  }

  if (cmd === 'describe') {
    holding();
    const [file] = rest;
    if (!file) throw new ShapeUsage('Usage: agent.mjs describe <key> <file.md>');
    const body = readFile(file, 'utf8');
    // The description it replaces stays readable in a comment.
    if (item.body.trim()) await client.comment(key, `The description before ${me} rewrote it:\n\n${item.body}\n\n<!-- agent: ${me} -->`);
    await client.editIssue(key, { body });
    return { key, described: true };
  }

  if (cmd === 'create') {
    holding();
    const [file] = rest;
    if (!file) throw new ShapeUsage(`Usage: agent.mjs ${SHAPE_USAGE.split(' | ').find((u) => u.startsWith('create'))}`);
    const { title, body } = titled(readFile(file, 'utf8'), opt(args, 'title'));
    const given = keys(opt(args, 'labels'));
    // A slice is for the parent's repository unless it says otherwise.
    const repo = given.some((l) => l.startsWith('repo/')) ? [] : labelNames(item).filter((l) => l.startsWith('repo/'));
    const labels = [...new Set([SHAPED, ...given, ...repo])].filter((l) => l === SHAPED || !l.startsWith(NS));
    const made = await client.createIssue(title, body, labels, { parent: key, priority: opt(args, 'priority') ?? null });
    const blockedBy = keys(opt(args, 'blocked-by'));
    if (made && blockedBy.length) await client.relate(made.key, 'blocked_by', blockedBy);
    return { parent: key, created: made?.key ?? null, title, labels, blockedBy, url: made?.html_url ?? null };
  }

  if (cmd === 'blocked-by') {
    holding();
    const blockedBy = keys(rest[0]);
    if (!blockedBy.length) throw new ShapeUsage('Usage: agent.mjs blocked-by <key> <key,key>');
    await client.relate(key, 'blocked_by', blockedBy);
    return { key, blockedBy };
  }

  if (cmd === 'labels') {
    holding();
    const changes = rest.map((r) => ({ add: r.startsWith('+'), name: r.slice(1) }));
    if (!changes.length || rest.some((r) => !/^[+-]./.test(r))) throw new ShapeUsage('Usage: agent.mjs labels <key> +<name> -<name>…');
    const theirs = changes.filter((c) => c.name.startsWith(NS));
    if (theirs.length) throw new ShapeUsage(`${theirs.map((c) => c.name).join(', ')}: swarm/ labels change only through their own commands (PROTOCOL.md, "The labels").`);
    // Removals first: a group that takes one label (`area`, `platform`, `repo`) takes `-area/app +area/api` as a swap.
    for (const c of changes.filter((x) => !x.add)) await client.removeLabel(key, c.name);
    for (const c of changes.filter((x) => x.add)) await client.addLabel(key, c.name);
    return { key, added: changes.filter((c) => c.add).map((c) => c.name), removed: changes.filter((c) => !c.add).map((c) => c.name) };
  }

  if (cmd === 'attach') {
    holding();
    if (!rest.length) throw new ShapeUsage('Usage: agent.mjs attach <key> <file>…');
    const attached = [];
    for (const file of rest) {
      const type = TYPES[extname(file).toLowerCase()];
      if (!type) throw new ShapeUsage(`${file}: attach takes ${Object.keys(TYPES).join(', ')}.`);
      attached.push(await client.attach(key, { name: basename(file), type, bytes: readFile(file) }));
    }
    return { key, attached: attached.filter(Boolean).map((a) => a.name) };
  }

  if (cmd === 'shaped') {
    holding();
    const text = rest.join(' ').trim();
    if (!text) throw new ShapeUsage('Usage: agent.mjs shaped <key> "<what you did, what the owner should look at, and any design PR>"');
    await client.comment(key, `${text}\n\n<!-- agent: ${me} -->`);
    await client.addLabel(key, SHAPED);
    for (const label of [GROOM, DESIGN]) if (labelNames(item).includes(label)) await client.removeLabel(key, label);
    await client.removeLabel(key, AGENT_PREFIX + me);
    return { key, shaped: true, released: [key] };
  }
  throw new ShapeUsage(`Unknown command ${cmd}.`);
}
