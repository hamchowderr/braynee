---
name: health
description: >
  Run a Brain Check — audit your second brain across Setup, Connections, Memory, and Inbox.
  Use when user says "brain check", "health check", "system status", "what's broken",
  "what needs attention", "check connections", "what's backed up".
argument-hint: [check | setup | connections | memory | inbox | self-test]
allowed-tools: Bash(python3:*), Bash(node:*), Bash(curl:*), Bash(brainy-self-test:*)
---

# Health Skill — Brain Check

Audits the Brainy system across four areas and surfaces what's broken or backed up right now.

## Commands

```bash
# Full Brain Check (all four areas)
python3 {baseDir}/scripts/health.py check

# Check tools and plugin scripts are installed
python3 {baseDir}/scripts/health.py setup

# Verify live integrations are reachable
python3 {baseDir}/scripts/health.py connections

# Check Claude's context is current
python3 {baseDir}/scripts/health.py memory

# Surface what's backed up or unprocessed
python3 {baseDir}/scripts/health.py inbox

# Plugin self-test — validates every hook, monitor, script, skill, agent
node {baseDir}/../../bin/brainy-self-test
```

## Self-Test (`self-test` subcommand)

Run when something feels broken with brainy itself, or after editing the plugin source. Validates:

- All 21 hook scripts parse and execute with mock stdin (no crashes)
- hooks.json + monitors.json + plugin.json schema valid
- All 17 skills + 6 agents have valid frontmatter
- All 4 bundled scripts (qmd-wrapper, vault-query, tasknotes, beads-dashboard) are callable
- All 3 monitors can boot

Exit code 0 = everything passed. Non-zero = at least one check failed (output shows which).

For machine-readable output use `--json`:
```bash
node {baseDir}/../../bin/brainy-self-test --json
```

The same self-test runs in CI on every push to master across Ubuntu, macOS, and Windows.

## Brain Check Framework

**Setup** — Are the tools and scripts installed and working?
- `obsidian`, `bd`, `node`, `python3`, `qmd` all available?
- Plugin scripts reachable via `{baseDir}`?

**Connections** — Are live integrations actually reachable?
- Beads (issue tracking)
- Granola meeting cache
- ProtonMail CLI
- QMD index

**Memory** — Is Claude loaded with current context?
- `~/.claude/CLAUDE.md` reflects current setup?
- Vault CLAUDE.md up to date?
- Priorities reflecting actual focus?

**Inbox** — What's backed up or unprocessed right now?
- Inbox items waiting in `Inbox/`
- Sessions not yet synced to vault
- Stale open tasks
