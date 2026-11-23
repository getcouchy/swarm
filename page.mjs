#!/usr/bin/env node
// Pages the repository's owner when an agent puts swarm/needs-human on an issue or
// PR (see PROTOCOL.md, "When to call a person", and docs/ci.md, "Needs-human
// page"). An agent's question would otherwise sit among ordinary GitHub
// notifications; this sends it to one channel that carries nothing else.
//
// Runs from .github/workflows/needs-human-page.yml on the label's events, so
// it works however the label was set: by the tick tool, by hand, by a person.
//
// PAGE_URL is where the page goes. By default it is sent the way ntfy takes
// one (https://ntfy.sh/<topic>, or a self-hosted ntfy): the text as the body,
// and title, priority, tags and click as query parameters. PAGE_FORMAT=json
// posts one JSON object instead, for a webhook of your own. PAGE_TOKEN, when
// set, is sent as a bearer token. Every page carries `open`, the number of
// items still waiting, so a status display can show it without asking GitHub.
//
// Needs GITHUB_TOKEN (issues read), GITHUB_REPOSITORY and GITHUB_EVENT_PATH.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fromEnv } from './lib/github.mjs';
import { NEEDS_HUMAN, canonical, labelNames } from './lib/rules.mjs';

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The question an agent asked: the latest comment, without its HTML comments and trailer. */
export function question(comments) {
  const last = comments.at(-1)?.body ?? '';
  const text = last.replace(/<!--[\s\S]*?-->/g, '').split(/\n---\n/)[0].replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  return clip(text, 400);
}

/**
 * What to send for one label event, or null for an event that isn't a page.
 * event: the GitHub event payload; open: items still labelled swarm/needs-human.
 */
export function pageFor(event, { open, asked = '' }) {
  const item = event.issue ?? event.pull_request;
  if (!item) return { state: 'test', title: 'Couchy: test page', text: `This is a test. ${open} waiting on you.`, priority: 3, tags: 'test_tube', open };
  const mine = canonical(event.label?.name ?? '') === NEEDS_HUMAN; // under its old name too
  const kind = event.pull_request || item.pull_request ? 'PR' : 'Issue';
  const base = { number: item.number, url: item.html_url, open };
  if (event.action === 'labeled' && mine) {
    return {
      ...base, state: 'waiting', priority: 5, tags: 'rotating_light',
      title: `Couchy needs you: #${item.number} ${clip(item.title, 80)}`,
      text: `${asked || `${kind} #${item.number} is waiting on a decision from you.`}\n\n${open} waiting on you.`,
    };
  }
  const cleared = (event.action === 'unlabeled' && mine) ||
    (event.action === 'closed' && labelNames(item).includes(NEEDS_HUMAN));
  if (!cleared) return null;
  return {
    ...base, state: 'cleared', priority: 2, tags: 'white_check_mark',
    title: `Couchy: #${item.number} no longer needs you`,
    text: open ? `${open} still waiting on you.` : 'Nothing is waiting on you.',
  };
}

/** The HTTP request for a page: ntfy's shape by default, one JSON object with format 'json'. */
export function request(page, { url, format = 'ntfy', token = '' }) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (format === 'json') {
    return { url, init: { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(page) } };
  }
  const to = new URL(url);
  // Query parameters, not headers: a title may hold characters a header can't.
  for (const [k, v] of Object.entries({ title: page.title, priority: page.priority, tags: page.tags, click: page.url })) {
    if (v !== undefined) to.searchParams.set(k, String(v));
  }
  return { url: to.href, init: { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }, body: page.text } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = process.env.PAGE_URL;
  if (!url) {
    console.log('::notice::PAGE_URL is not set; no page sent.');
    process.exit(0);
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const gh = fromEnv();
  const item = event.issue ?? event.pull_request;
  // The issues list holds pull requests too, which is what is wanted here.
  const open = (await gh.labelled(NEEDS_HUMAN)).length;
  const asked = item && event.action === 'labeled' ? question(await gh.comments(item.number)) : '';
  const page = pageFor(event, { open, asked });
  if (!page) {
    console.log('Not a needs-human event; no page sent.');
    process.exit(0);
  }
  const { url: to, init } = request(page, { url, format: process.env.PAGE_FORMAT || 'ntfy', token: process.env.PAGE_TOKEN });
  const res = await fetch(to, init);
  if (!res.ok) {
    console.error(`Page not delivered: ${res.status} ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`Paged (${page.state}): ${page.title}`);
}
