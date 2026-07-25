---
name: recap
description: >
  Load context from previous Claude Code sessions and vault notes.
  Temporal queries scan JSONL session files by date.
  Topic queries use QMD BM25 search with query expansion.
  Every recap ends with "One Thing" — the single highest-leverage next action.
  Use when user says "recap", "what did we work on", "what was I doing",
  "load context", "yesterday", "last week", "remember when", "prime context".
argument-hint: "[yesterday | today | last week | TOPIC | graph DATE_EXPR]"
allowed-tools: Bash(python3:*, node:*)
---

# Recap Skill

Three modes: temporal (JSONL date scan), topic (QMD BM25), graph (session visualization).
Every recap ends with **One Thing** — the single most impactful next action.

## Usage

```
/recap yesterday
/recap last week
/recap 2026-05-01
/recap authentication bug
/recap company research
/recap graph last week
```

## Workflow

See `workflows/recap.md` for routing logic.

## Commands

```bash
# Temporal — list sessions by date
python3 {baseDir}/scripts/recap.py list yesterday
python3 {baseDir}/scripts/recap.py list "last week"
python3 {baseDir}/scripts/recap.py list "last 3 days"

# Expand a session
python3 {baseDir}/scripts/recap.py expand SESSION_ID

# Topic — QMD search with expansion
node ${CLAUDE_PLUGIN_ROOT}/scripts/qmd-wrapper.mjs search "QUERY" 
node ${CLAUDE_PLUGIN_ROOT}/scripts/qmd-wrapper.mjs vsearch "QUERY"

# Graph
python3 {baseDir}/scripts/recap.py graph yesterday --out ~/Downloads/recap-graph.html
```

## One Thing

After presenting results, synthesize:
- What has the most momentum right now?
- What's closest to done?
- What's blocked and needs a decision?

Output: one specific, actionable next step. Not generic ("work on project") — concrete ("finish the scaffold.py script for the setup skill").
