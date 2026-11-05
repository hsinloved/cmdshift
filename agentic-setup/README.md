# Agentic setup

A copy of the setup from [The Agentic System of an Applied AI Engineer](https://prakhar.codes/blog/the-agentic-system-of-an-applied-ai-engineer/),
with four parts: a cockpit (T3 Code), a model gateway (CLIProxyAPI), a tool gateway (Executor)
and a skills repo. This folder holds the parts that are files. The servers and apps you set
up by hand on each machine, using the steps below.

```
agentic-setup/
  install.py              per-machine installer, safe to re-run
  claude/settings.json    user-level Claude Code settings: proxy, key helper, status line, skill hooks
  claude/CLAUDE.md        global "tools go through Executor" block (also used for ~/.codex/AGENTS.md)
  cliproxy/claude-key.sh  apiKeyHelper: reads the proxy key from secrets.env or the macOS Keychain
  cliproxy/statusline.py  status line: model, folder, and each pooled Claude account's state
  cliproxy/cliproxy-account   list / turn off / turn on a pooled account
  agent-skills/           template for your private skills repo (move it to its own repo)
    global/               skills linked into every project
    cmdshift/             skills linked only into hsinloved/cmdshift
    projects.json         folder -> git remotes ("owner/repo", "owner/*")
    bin/skills-hook.py    SessionStart / SessionEnd hook
```

## 1. Skills repo

1. Create a **private** GitHub repo, for example `agent-skills`, and push the contents of
   `agent-skills/` to it.
2. Put skills in `global/<name>/SKILL.md` or `<project>/<name>/SKILL.md`, and map each
   project folder to its remotes in `projects.json`.
3. On each machine: `git clone <that repo> ~/agent-skills`. `install.py --skills-remote`
   does this for you.

On session start the hook links `global/` into `~/.claude/skills` and `~/.agents/skills`.
It matches the repo's `origin` remote against `projects.json` and links that project's skills
into `.claude/skills` and `.agents/skills`. Those links are hidden in `.git/info/exclude`, which
every worktree shares. Then it pulls in the background. On session end it commits and pushes
any skill edits. Skills linked for the first time are named in the session's context, because
Claude Code reads its skill list before the hook runs. The sync log is
`~/agent-skills/.sync.log`.

## 2. Model gateway: CLIProxyAPI

1. Host [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) somewhere every machine can
   reach (Tailscale works well). Log in each Claude account, set a client key in `api-keys`, and
   set `remote-management.secret-key`. For fill-first routing with session affinity, set
   `routing.strategy: "fill-first"` and `routing.session-affinity: true` in `config.yaml`.
2. On each machine: `python3 install.py --proxy-url https://<your-proxy>`, then fill in
   `~/.config/cliproxy/secrets.env` (chmod 600). Alternatively, keep the client key in the Keychain:
   `security add-generic-password -a "$USER" -s cliproxy-api-key -w`.
3. Give T3's Claude provider the same `ANTHROPIC_BASE_URL` and `apiKeyHelper`.

`cliproxy-account list`, `cliproxy-account off <name>` and `cliproxy-account on <name>` call
`/v0/management/auth-files[/status]`.

Limits:
- With a key in place of a claude.ai login, Claude Code turns off the claude.ai connectors.
  That's intended, because every tool goes through Executor.
- Stock CLIProxyAPI does not report each account's 5-hour and weekly percentages. The status
  line shows ● active, ○ disabled and ✕ cooling down, plus the request count. For the
  percentages, install a quota plugin and read `/v8/management/plugins/<id>/quota`.

## 3. Tool gateway: Executor

1. Self-host [Executor](https://executor.sh/) and connect your services. Use per-service tools
   (the default mode), **not** passthrough, so each service shows up by name.
2. Create two Executor tokens, one that sees work connections and one that sees personal ones.
3. Personal, user-level (every folder):
   ```bash
   claude mcp add --scope user --transport http executor https://<executor>/mcp --header "Authorization: Bearer <personal-token>"
   ```
4. Work, per folder (run inside each work repo, worktree and review checkout). Local scope
   is stored in `~/.claude.json` under that folder, so nothing is committed:
   ```bash
   claude mcp add --scope local --transport http executor https://<executor>/mcp --header "Authorization: Bearer <work-token>"
   ```
   Check Executor's docs for its exact MCP path and auth scheme. The commands above assume a
   bearer token.
5. Edit the service list in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` to match, and turn off
   any other plugin or connector for those services.
6. If Executor runs in a container with no network device, run Tailscale in userspace as a
   sidecar and send Executor's outbound traffic through the sidecar's HTTP proxy.

## 4. Cockpit: T3 Code

On each machine:
1. Install [T3 Code](https://github.com/pingdotgg/t3code) and run `t3 service install`.
2. Connect the app to each server, through T3 Connect or Tailscale HTTPS pairing links.
3. Turn on Settings → Labs → Linked environments, then link the machines under
   Settings → Environments → Linked environments. Links expire after 30 days.
4. Optional: load balancing, worktree cleanup, idle compaction.
5. Close the loop: copy the MCP URL from Settings → Environments → Copy MCP URL and add it to
   Executor as an integration, then make Executor the MCP server for T3's agents.

## Order on a new machine

```bash
git clone git@github.com:<you>/agent-skills.git ~/agent-skills
python3 agentic-setup/install.py --proxy-url https://<your-proxy>
$EDITOR ~/.config/cliproxy/secrets.env
claude mcp add --scope user --transport http executor https://<executor>/mcp --header "Authorization: Bearer <personal-token>"
```
