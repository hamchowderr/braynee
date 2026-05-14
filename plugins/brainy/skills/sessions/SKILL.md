---
name: sessions
description: >
  Export Claude Code sessions to Obsidian markdown. Sync, list, resume, annotate sessions.
  Use when user says "sync session", "export session", "log session",
  "add session note", "close session", "resume session".
argument-hint: [sync | list | export --today | resume | note TEXT | close TEXT]
allowed-tools: Bash(python3:*)
---

# Sync Sessions Skill

Export Claude Code conversations to `2. Areas/Sessions/` as structured Obsidian notes.

## Commands

```bash
# Sync current session
python3 {baseDir}/scripts/sessions.py sync

# Export today's sessions
python3 {baseDir}/scripts/sessions.py export --today

# Export all sessions
python3 {baseDir}/scripts/sessions.py export --all

# List active sessions
python3 {baseDir}/scripts/sessions.py list

# Resume a session (pick from list)
python3 {baseDir}/scripts/sessions.py resume --pick

# Add timestamped note to current session
python3 {baseDir}/scripts/sessions.py note "figured out the auth bug"

# Close session with summary
python3 {baseDir}/scripts/sessions.py close "scaffold complete, moving to next task"
```

## Output Format

Sessions exported to `2. Areas/Sessions/` with frontmatter:

```yaml
---
type: claude-session
date: YYYY-MM-DD
session_id: uuid
title: "..."
summary: "..."
messages: 42
status: active | done | blocked | handoff
tags: []
rating: null
comments: |
  [2026-05-04 10:30] Note here
---
```

## Preserved on Re-Sync

- `## My Notes` section
- `comments`, `tags`, `rating`, `status` frontmatter fields

## Auto-Sync Hook

Your `~/.claude/settings.json` already has `session-export-qmd.js` and `session-auto-close.js`
on the Stop event — no additional hooks needed. Session export is already automated.

Use the `export` command manually when you want to bulk-sync historical sessions.
