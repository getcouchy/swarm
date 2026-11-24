// A small GitHub REST client for the agent tools. Reads GITHUB_TOKEN (or
// GH_TOKEN) and GITHUB_REPOSITORY; DRY_RUN=true logs writes without making them.

import { bodyBlockers, isInsider, oldName, verdictIn } from './rules.mjs';

export function client({ token, repo, dryRun = false, log = console.error, fetchImpl = fetch }) {
  let remaining = null; // requests left in the token's hour, as the last response gave it
  async function api(method, path, body) {
    const url = path.startsWith('http') ? path : `https://api.github.com${path.startsWith('/repos') ? path : `/repos/${repo}${path}`}`;
    if (dryRun && method !== 'GET') {
      log(`[dry run] ${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''}`);
      return null;
    }
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const left = res.headers?.get?.('x-ratelimit-remaining');
    if (left != null) remaining = Number(left);
    if (!res.ok) {
      const err = new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  async function all(path) {
    const out = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; ; page++) {
      const batch = await api('GET', `${path}${sep}per_page=100&page=${page}`);
      const rows = Array.isArray(batch) ? batch : (batch.check_runs ?? []);
      out.push(...rows);
      if (rows.length < 100) return out;
    }
  }

  const enc = encodeURIComponent;
  /**
   * Open issues and PRs carrying every one of `labels`, oldest first. A swarm
   * label is also looked for under the name it had before the namespace, so
   * the lists are whole while old labels are still about.
   */
  async function withLabels(labels, more = '') {
    const sets = labels.reduce((acc, l) => acc.flatMap((set) => [l, oldName(l)].filter(Boolean).map((name) => [...set, name])), [[]]);
    const seen = new Map();
    for (const set of sets) {
      const q = [set.length ? `labels=${set.map(enc).join(',')}` : '', more].filter(Boolean).join('&');
      for (const i of await all(`/issues?state=open${q ? `&${q}` : ''}`)) seen.set(i.number, i);
    }
    return sets.length > 1 ? [...seen.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)) : [...seen.values()];
  }
  const writers = new Map(); // login -> whether it may write here, asked once per run
  const canWrite = (login) => {
    if (!writers.has(login)) {
      writers.set(login, api('GET', `/collaborators/${enc(login)}/permission`).then((p) => ['admin', 'write'].includes(p.permission), (e) => {
        // Only "no such collaborator" is an answer. Any other failure is thrown: read as a no, it would turn every verdict off.
        if (e.status === 404) return false;
        throw e;
      }));
    }
    return writers.get(login);
  };
  const required = new Map(); // branch -> its required checks, read once per run
  async function readRequired(branch) {
    try {
      return (await all(`/rules/branches/${enc(branch)}`))
        .filter((r) => r.type === 'required_status_checks')
        .flatMap((r) => r.parameters.required_status_checks.map((c) => c.context));
    } catch (e) {
      if (e.status === 404 || e.status === 403) return [];
      throw e;
    }
  }
  const states = new Map(); // issue path -> state, for one run
  return {
    repo,
    dryRun,
    /** GitHub API requests left in the token's hour, or null before the first response. */
    rateLimitRemaining: () => remaining,
    /** Open issues (no PRs) carrying every one of `labels`, oldest first. */
    openIssues: async (labels = []) => (await withLabels(labels, 'sort=created&direction=asc')).filter((i) => !i.pull_request),
    /** Open issues and pull requests carrying a label. */
    labelled: (label) => withLabels([label]),
    labels: () => all('/labels'),
    renameLabel: (name, to) => api('PATCH', `/labels/${enc(name)}`, { new_name: to }),
    openPulls: () => all('/pulls?state=open&sort=created&direction=asc'),
    /** The 50 most recently updated closed pull requests, merged or not. */
    closedPulls: () => api('GET', '/pulls?state=closed&sort=updated&direction=desc&per_page=50'),
    issue: (n) => api('GET', `/issues/${n}`),
    addLabel: (n, name) => api('POST', `/issues/${n}/labels`, { labels: [name] }),
    removeLabel: async (n, name) => {
      // Under its old name too, in case that is how it was put on.
      for (const label of [name, oldName(name)].filter(Boolean)) {
        try {
          await api('DELETE', `/issues/${n}/labels/${enc(label)}`);
        } catch (e) {
          if (e.status !== 404) throw e; // already gone
        }
      }
    },
    comments: (n) => all(`/issues/${n}/comments`),
    comment: (n, body) => api('POST', `/issues/${n}/comments`, { body }),
    editComment: (id, body) => api('PATCH', `/issues/comments/${id}`, { body }),
    events: (n) => all(`/issues/${n}/events`),
    /** A PR's reviews, and the comments that carry a verdict: an agent may leave its verdict in either. */
    reviews: async (n) => {
      const [reviews, comments] = await Promise.all([all(`/pulls/${n}/reviews`), all(`/issues/${n}/comments`)]);
      const said = [...reviews, ...comments.filter((c) => verdictIn(c.body)).map((c) => ({ ...c, state: 'COMMENTED', submitted_at: c.created_at }))];
      return Promise.all(said.map(async (r) => (isInsider(r) || r.user?.type !== 'User' ? r : { ...r, trusted: await canWrite(r.user.login) })));
    },
    checks: (sha) => all(`/commits/${sha}/check-runs`),
    /** Every run, not only the latest of each name: a skipped one hides a real one. */
    allChecks: (sha) => all(`/commits/${sha}/check-runs?filter=all`),
    commit: (sha) => api('GET', `/commits/${sha}`),
    statuses: (sha) => all(`/commits/${sha}/statuses`),
    setStatus: (sha, status) => api('POST', `/statuses/${sha}`, status),
    pull: (n) => api('GET', `/pulls/${n}`),
    /** Names of the status checks a branch's rules require; [] when they can't be read. */
    requiredChecks: (branch = 'main') => {
      if (!required.has(branch)) required.set(branch, readRequired(branch));
      return required.get(branch);
    },
    /**
     * What still blocks an issue, as ["#641", "getcouchy/couchy-agent#5 (can't read it)"]:
     * the open issues its body names after "Blocked by", plus GitHub's own
     * dependency links. A blocker this token can't read counts as open, since
     * taking blocked work costs more than waiting for a person to look.
     */
    blockers: async (issue) => {
      const open = new Set();
      for (const { repo: other, number } of bodyBlockers(issue.body)) {
        const name = `${other && other !== repo ? other : ''}#${number}`;
        const path = `/repos/${other ?? repo}/issues/${number}`;
        if (!states.has(path)) {
          states.set(path, await api('GET', path).then((i) => i.state, (e) => {
            if (e.status === 404 || e.status === 403) return 'unreadable';
            throw e;
          }));
        }
        if (states.get(path) === 'open') open.add(name);
        if (states.get(path) === 'unreadable') open.add(`${name} (can't read it)`);
      }
      try {
        for (const i of await all(`/issues/${issue.number}/dependencies/blocked_by`)) {
          if (i.state === 'open') open.add(`#${i.number}`);
        }
      } catch (e) {
        if (e.status !== 404) throw e; // no dependencies API on this repo
      }
      return [...open];
    },
    /**
     * The numbers of an issue's sub-issues in this repository, in the order
     * GitHub shows them (the owner's order), each followed by its own
     * sub-issues, three levels down at most. [] where the repository has no
     * sub-issues API.
     */
    subIssues: async function subIssues(number, depth = 3) {
      let rows;
      try {
        rows = await all(`/issues/${number}/sub_issues`);
      } catch (e) {
        if (e.status === 404) return [];
        throw e;
      }
      const out = [];
      for (const i of rows) {
        if (i.repository_url && !i.repository_url.toLowerCase().endsWith(`/repos/${repo.toLowerCase()}`)) continue;
        out.push(i.number);
        if (depth > 1 && i.sub_issues_summary?.total > 0) out.push(...await subIssues(i.number, depth - 1));
      }
      return out;
    },
    ensureLabel: async (name, color, description) => {
      try {
        await api('GET', `/labels/${enc(name)}`);
      } catch (e) {
        if (e.status !== 404) throw e;
        log(`Creating label ${name}`);
        await api('POST', '/labels', { name, color, description });
      }
    },
    createIssue: (title, body, labels) => api('POST', '/issues', { title, body, labels }),
    editIssue: (n, patch) => api('PATCH', `/issues/${n}`, patch),
  };
}

export function fromEnv(env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const repo = env.GITHUB_REPOSITORY || 'getcouchy/couchy';
  return forRepo(repo, env, token);
}

/** The repositories one tick covers: AGENT_REPOS, or this one and couchy-agent. */
export function reposFromEnv(env = process.env) {
  const first = env.GITHUB_REPOSITORY || 'getcouchy/couchy';
  const names = (env.AGENT_REPOS ?? `${first},getcouchy/couchy-agent`).split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(names)].map((repo) => forRepo(repo, env));
}

function forRepo(repo, env, token = env.GITHUB_TOKEN || env.GH_TOKEN) {
  if (!token) {
    console.error('GITHUB_TOKEN (or GH_TOKEN) is required. Without a token, follow "By hand" in PROTOCOL.md.');
    process.exit(2);
  }
  return client({ token, repo, dryRun: env.DRY_RUN === 'true' });
}
