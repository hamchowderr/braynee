---
name: daily
description: >
  Open, create, or update today's daily note. Review yesterday, plan today, log progress.
  Use when user says "open today", "daily note", "what's today", "log this",
  "what did I do yesterday", "plan my day", "morning review", "EOD".
argument-hint: "[open | yesterday | plan | log TEXT | eod]"
allowed-tools: Bash(python3:*), Bash(obsidian:*)
---

# Daily Skill

Manages your daily notes in `2. Areas/Sessions/` and `Inbox/` for quick captures.

## Commands

```bash
# Open or create today's daily note
python3 {baseDir}/scripts/daily.py open

# Review yesterday's note
python3 {baseDir}/scripts/daily.py yesterday

# Log a quick note to today's note
python3 {baseDir}/scripts/daily.py log "shipped auth, starting on payments"

# Generate EOD summary (pulls from tasks + sessions)
python3 {baseDir}/scripts/daily.py eod
```

## Daily Note Format

```markdown
---
type: daily
date: YYYY-MM-DD
---

# YYYY-MM-DD

## Plan

- [ ] Task 1
- [ ] Task 2

## Log

[10:30] Started on X
[14:00] Shipped Y

## EOD

What shipped, what blocked, what's next.
```

## Auto-Open on Session Start

Today's note is automatically surfaced in context via `vault-context-prime.js`.
You don't need to explicitly open it — just log to it mid-session.
