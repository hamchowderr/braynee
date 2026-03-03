# claude-plugins

A marketplace of Claude Code plugins for power users.

## Installation

```shell
# Add the marketplace
/plugin marketplace add hamchowderr/claude-plugins

# Browse available plugins
/plugin
```

## Plugins

### Insightful

Generate a comprehensive HTML insights report from your **entire** Claude Code history — every session, every project, all time.

**The built-in `/insights` only covers recent sessions.** Insightful goes deeper:

| Feature | `/insights` | Insightful |
|:--------|:------------|:-----------|
| Scope | Recent sessions | Every session ever |
| Data sources | 1 (stats-cache) | 5 (history, stats-cache, facets, indexes, transcripts) |
| Git commits | No | Detected from session transcripts |
| Hours spent | No | Calculated from timestamps |
| Concurrent sessions | No | Multi-clauding detection |
| Notable sessions | No | Top 5 highlighted |
| Usage evolution | No | Month-over-month trends |
| Pre-tracking data | Lost | Recovered from history.jsonl |
| Output format | Terminal text | Interactive HTML with charts |

**Install:**

```shell
/plugin install insightful@hamch-plugins
```

**Use:**

```
/insightful
```

This generates a rich HTML report at `~/.claude/usage-data/insightful-report.html` with:
- Project breakdowns with session details
- Interaction style analysis
- Tool, model, and working hours charts
- Friction analysis with specific examples
- CLAUDE.md suggestions with copy buttons
- Features to try and workflow patterns
- Multi-clauding stats and notable sessions
- Evolution over time and usage timeline

### System Walkthrough

Point it at any codebase and get a complete Obsidian-compatible walkthrough with wikilinks. Autonomously reads through the code, maps the architecture, and produces interlinked documentation a senior dev could use to onboard.

**Install:**

```shell
/plugin install system-walkthrough@claude-plugins
```

**Use:**

Just ask Claude to document a codebase:

```
Walk through this codebase and document it
```

It will survey the project, read through the important files, and output a set of interlinked Obsidian Markdown files covering architecture, data model, routes, core logic, integrations, and configuration.

## License

MIT
