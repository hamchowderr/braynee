---
name: settings-viewer
description: >
  Opens a live visual dashboard of your Claude Code configuration and usage analytics.
  Use when user says "open braynee", "show my settings", "view my Claude Code config",
  "open settings dashboard", "show my analytics", "how much have I used Claude Code",
  or any request to inspect their Claude Code configuration or usage data visually.
argument-hint: "[open | refresh]"
allowed-tools: Bash(node:*), Bash(start:*), Bash(powershell:*)
disable-model-invocation: true
---

# Settings Viewer (Braynee Dashboard)

Generates a visual HTML dashboard of the user's Claude Code settings and usage analytics, then opens it in the browser.

## How to execute

```bash
node "{baseDir}/scripts/dashboard.mjs"
```

`dashboard.mjs` opens the dashboard in whichever **delivery mode** the user has chosen (see below). It defaults to **file mode** — identical to the old behavior — so this just works out of the box.

---

## Delivery modes

The dashboard can be delivered two ways, selected by the `BRAYNEE_DASHBOARD_MODE` env var (set it in `~/.claude/settings.json` under `env`):

| Mode | What happens | When to use |
|:-----|:-------------|:------------|
| `file` *(default)* | `generate.mjs` rebuilds `~/.claude/temp/settings-viewer.html` and opens it. A fresh static snapshot each run. | Simplest; no running process. |
| `server` | A persistent localhost server (`127.0.0.1:7717`) serves the dashboard **live** from a warm cache, refreshing in the background. `dashboard.mjs` ensures it's up and opens its URL. | Always-current data without re-running the slow build; reachable from a browser tab you leave open. |

Optional in server mode: `BRAYNEE_DASHBOARD_PORT` (default `7717`), `BRAYNEE_DASHBOARD_REFRESH_MS` (default 5 min).

**Server mode is a singleton** — one managed instance shared across all Claude Code sessions (started lazily on first open, kept alive after). It binds `127.0.0.1` only, so it's private to the machine with no inbound exposure.

**Viewing inside Obsidian:** point the Custom Frames "Braynee" frame at `http://127.0.0.1:7717` (server mode) instead of the `settings-viewer.html` file, so the in-Obsidian tab is always live.

**Reaching it from your phone:** keep the server bound to localhost and expose it to your own devices over Tailscale with `tailscale serve --bg 7717` (tailnet-only HTTPS, never `tailscale funnel`). No public exposure.

> Note: as of the delivery-modes change, the dashboard no longer regenerates on every session start — it's on-demand (this skill) in file mode, and continuously live in server mode.

---

## Data Sources

All data is read locally — nothing is fetched remotely:

| File | Contents |
|:-----|:---------|
| `~/.claude/settings.json` | Permissions, hooks, plugins, env vars, MCP servers, status line |
| `~/.claude.json` | Runtime state: account, projects, skill usage, preferences |
| `~/.claude/CLAUDE.md` | User instruction prompt |
| `~/.claude/usage-data/insightful-summary.json` | Aggregated analytics (sessions, hours, tool counts, outcomes) |

---

## Dashboard Sections

### Braynee Panel
- Health summary: hooks active, skills installed, features enabled
- Quick status across all second-brain features

### Beads Panel
- Multi-project issue dashboard
- Issues by project, assignee filter, priority breakdown

### Config (sidebar)
- **General** — stat cards + core settings + env vars + status line
- **Permissions** — allow/ask/deny rules as color-coded chips
- **Hooks** — all lifecycle hook events with matcher and command
- **Plugins** — installed plugins with live/dead indicator
- **MCP Servers** — settings.json and user-level servers
- **CLAUDE.md** — full raw user instruction prompt

### Data (sidebar)
- **Projects** — all projects ranked by last-session cost
- **Skills** — skill usage frequency bars (top 20)
- **Preferences** — runtime prefs from .claude.json

### Insights (sidebar)
- **Analytics** — session outcomes, satisfaction, friction, goal categories
- **Tool Usage** — all-time tool call totals ranked by frequency
- **Project Hours** — all tracked projects ranked by total hours
