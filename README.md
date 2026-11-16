# swarm

The protocol and tools for the coding agents (Claude, Codex, Grok…) that work
on the getcouchy repositories at once. [`PROTOCOL.md`](PROTOCOL.md) is the
protocol; each repository's own `AGENTS.md` points here and adds its own rules.

This repository is public on purpose: an agent's sandbox can clone it without
being given access to it, so a tick needs access only to the repository it
works in.

`agent.mjs`, `tick.mjs` and `sweep.mjs` run the protocol. `bots.mjs` gives each
agent a GitHub identity of its own. Tests: `npm test` (`node --test`, no
dependencies).

## Using it in a tick

Clone it beside the checkout you work in, and run the tools from that checkout:

```sh
git clone --depth 1 https://github.com/getcouchy/swarm ../swarm
AGENT_NAME=claude-3 node ../swarm/agent.mjs next
```

Every command checks its clone against `origin/main` and runs `main`'s copy if
they differ, so an old clone never applies old rules.

With `TICK_EVENTS_FILE` set, each `agent.mjs` command that runs to completion
appends one JSON line to that file: the job it offered, the locks it took or
released (each with its repository, number and `issue` or `pull`) and the
GitHub requests left on the token. The tick runner in getcouchy/agent-runner
sets it for each run and turns the lines into live metrics; how it reads them
is documented there. Unset, nothing is written.

Two of the tools run on a schedule outside any tick: for getcouchy/couchy,
CronJobs on kube-1 (the `couchy-swarm` chart in getcouchy/ops) download this
repository's `main` and run `reviewed.mjs` every 2 minutes and `sweep.mjs`
every 10, by those paths. Moving or renaming either file needs the chart's
`values.yaml` changed and deployed at the same time: until it is, no pull
request gets its required `reviewed` status and none can merge. The workflows
in getcouchy/couchy that check this repository out with `actions/checkout`
(`agent-sweep.yml`, `agent-reviewed.yml`, `needs-human-page.yml`) are disabled.

A change to these tools changes what guards a merge in every repository that
uses them, so a PR here follows PROTOCOL.md, "The exceptions", like one that
touches a required check.

## Running the housekeeping

`sweep.mjs` and `reviewed.mjs` need only a GitHub token and the API, so they
can run outside CI. [`charts/swarm`](charts/swarm) is a Helm chart that runs
them (and scripts of your own) as Kubernetes CronJobs under a GitHub App:

```sh
helm upgrade --install swarm oci://ghcr.io/getcouchy/charts/swarm --version 0.2.1 \
  -n swarm --set github.repository=<owner>/<repo>
```

Its [README](charts/swarm/README.md) has the GitHub App and the Secret to
create first.

Both scripts can push what they find to a Prometheus Pushgateway, for a
dashboard and alerts in place of reading the Agent desk:
[`docs/metrics.md`](docs/metrics.md).

## A GitHub identity per agent

Every agent name (`codex`, `grok`, `claude-2`…) can get its own private GitHub App
in the org, named `couchy-<name>`. The agent then pushes, opens PRs, comments,
labels and reviews as **`couchy-<name>[bot]`**, and its commits link to that bot,
so the history and every thread say which agent did what.

### Why apps and not machine users

| | GitHub App per agent (this) | Machine user per agent |
|---|---|---|
| Making one | `bots.mjs create <name>`: two clicks | A new signup each: email, captcha, 2FA, an org invite |
| Allowed | As many as you like | GitHub's terms allow one free machine account per person |
| Cost | Free, no seat | A seat each on a paid org plan |
| Credentials | A private key; tokens last an hour and `bots.mjs` mints them | A PAT you rotate by hand |
| Reach | Only the repos you pick, only the permissions below | Whatever the account is a member of |
| Shows as | `couchy-codex[bot]` | `couchy-codex` |
| Can't | Be assigned an issue, or be requested as a reviewer | |

The protocol never assigns or requests anyone, it uses `swarm/agent/<name>` labels,
so what an app can't do doesn't matter here.

### What an app may do

Repository permissions only: contents, pull requests, issues and workflows
(write); checks, statuses and actions (read). No org settings, no members, no
admin. Change them on the app's settings page; the org then has to accept the
new permissions on the installation.

`workflows` and `contents` together let a bot change what CI runs on its own
branches. That is no more than the shared account can do today, but it is why a
bot key should be guarded like a person's token.

### Making one (needs you, as an org owner, once per agent)

On your own machine, from a clone of this repository:

```sh
node bots.mjs create codex     # --port=8787 by default
```

1. A browser opens on GitHub's **Create GitHub App for getcouchy** page, filled
   in. Click **Create GitHub App**.
2. GitHub sends you back to the script, which saves the app to
   `~/.config/couchy-bots/codex/` (`app.json` and `private-key.pem`, both
   `0600`) and forwards the browser to the install page. Pick **Only select
   repositories** (or all) and click **Install**.
3. `node bots.mjs check codex` mints a token and prints the bot's
   git author and the repos it reaches.

The app name must be free on all of GitHub. If `couchy-codex` is taken, GitHub
says so on the form; rename it there, and the script follows the slug GitHub gives.

`node bots.mjs list` shows every app made on this machine and
whether it is installed.

### Giving it to the agent

```sh
node bots.mjs export codex
```

prints five `COUCHY_BOT_*` lines (the key base64'd onto one line). Put them in
the agent's secret store: its sandbox's environment variables, a CI secret, the
host's env file. Treat them like a password: whoever has the key can act as the
bot until you revoke it.

Inside the sandbox, with those variables set:

```sh
eval "$(node ../swarm/bots.mjs env)"   # GH_TOKEN, GITHUB_TOKEN, AGENT_NAME, GIT_AUTHOR_*, GIT_COMMITTER_*
node ../swarm/bots.mjs git-setup       # or: this clone commits and pushes as the bot for good
```

`env` covers `gh`, `agent.mjs` and anything else that reads `GH_TOKEN` or
`GITHUB_TOKEN`; tokens last an hour, so run it at the start of each tick.
`git-setup` sets `user.name`/`user.email` in the clone and a credential helper
that mints a fresh token whenever git pushes, so it never goes stale.

On the machine that made the app, name the agent instead: `env codex`,
`git-setup codex`, `token codex`.

### Claude cloud sessions

A Claude cloud session talks to GitHub through its GitHub connector, which acts
as the person who connected it, so its PRs and comments still show as that
person. With the `COUCHY_BOT_*` variables in the session's environment it can
still run `git-setup`, so its commits carry the bot as author. Until the session
can use the token for its GitHub calls, the `swarm/agent/<name>` label and the
`<!-- agent: <name> -->` marker stay how its work is told apart.

### Revoking or rotating

On GitHub: **getcouchy › Settings › Developer settings › GitHub Apps ›
couchy-codex**.

- Rotate: **Private keys › Generate a private key**, save it over
  `~/.config/couchy-bots/codex/private-key.pem`, run `export` again and update
  the sandbox, then delete the old key there.
- Pause: **getcouchy › Settings › GitHub Apps › couchy-codex › Suspend**.
- Remove: **Advanced › Delete GitHub App**, then delete `~/.config/couchy-bots/codex/`.

### How the agent tools treat bots

A review from `couchy-<name>[bot]` counts as that agent's review
(`independentReviews` in `rules.mjs`), the same as a person's: an unmarked one
counts only when it isn't the PR author's own bot. Reviews from other bots
(cubic) still never count.

The tools know an agent's bot by its login alone, so don't install any other app
named `couchy-…` on the org: its reviews would count as an agent's.

Tokens are cached for their hour beside the app (`~/.config/couchy-bots/<name>/token.json`)
or, in a sandbox, in `$COUCHY_BOTS_DIR/tokens/`; the script uses that directory only if it
is the user's own and `0700`, and otherwise mints a token on every call.
