---
name: wispr
description: >
  Access Wispr Flow voice dictation history. Stats, search, export, and dashboard.
  Reads directly from local SQLite — no API needed.
  Use when user says "dictation", "voice history", "how much did I dictate",
  "search my voice notes", "wispr", "wispr flow", "word count".
argument-hint: [stats | search QUERY | export | dashboard]
allowed-tools: Bash(python3:*, sqlite3:*)
---

# Wispr Flow Skill

Read and analyze Wispr Flow voice dictation history from local SQLite.

## Database

**Mac:** `~/Library/Application Support/Wispr Flow/flow.sqlite`
**Windows:** `%APPDATA%/Wispr Flow/flow.sqlite`

Table: `History` — columns: `timestamp` (UTC), `app`, `formattedText`, `numWords`, `duration`

## Commands

```bash
# Stats overview
python3 {baseDir}/scripts/wispr.py stats

# Stats for a period
python3 {baseDir}/scripts/wispr.py stats --period today
python3 {baseDir}/scripts/wispr.py stats --period week
python3 {baseDir}/scripts/wispr.py stats --period month

# Search dictations
python3 {baseDir}/scripts/wispr.py search "keyword"
python3 {baseDir}/scripts/wispr.py search "keyword" --app Obsidian
python3 {baseDir}/scripts/wispr.py search "keyword" --from 2026-01-01 --to 2026-01-31

# Recent dictations
python3 {baseDir}/scripts/wispr.py recent --limit 20

# Export to Obsidian
python3 {baseDir}/scripts/wispr.py export --format obsidian --out ~/vault/Voice/

# Generate HTML dashboard
python3 {baseDir}/scripts/wispr.py dashboard --out ~/Downloads/wispr-dashboard.html
```

## Quick SQL

```bash
# Today's words
sqlite3 "~/Library/Application Support/Wispr Flow/flow.sqlite" \
  "SELECT SUM(numWords) FROM History WHERE date(timestamp) = date('now')"

# Top apps by words
sqlite3 "~/Library/Application Support/Wispr Flow/flow.sqlite" \
  "SELECT app, SUM(numWords) as words FROM History GROUP BY app ORDER BY words DESC LIMIT 10"
```
