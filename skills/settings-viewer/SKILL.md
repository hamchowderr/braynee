---
name: settings-viewer
description: >
  Opens a live visual dashboard of your Claude Code configuration and usage analytics.
  Use when user says "open brainy", "show my settings", "view my Claude Code config",
  "open settings dashboard", "show my analytics", "how much have I used Claude Code",
  or any request to inspect their Claude Code configuration or usage data visually.
argument-hint: [open | refresh]
allowed-tools: Bash(node:*), Bash(start:*), Bash(powershell:*)
disable-model-invocation: true
---

# Settings Viewer (Brainy Dashboard)

Generates a visual HTML dashboard of the user's Claude Code settings and usage analytics, then opens it in the browser.

## How to execute

```bash
node "{baseDir}/scripts/generate.mjs"
```

This regenerates fresh every run. The output is written to `~/.claude/temp/settings-viewer.html` and opened automatically. If the browser doesn't open automatically, open that file manually.

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

### Brainy Panel
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
