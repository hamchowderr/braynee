---
name: sessions
description: >
  Export Claude Code sessions to Obsidian markdown. Sync, list, resume, annotate sessions.
  Use when user says "sync session", "export session", "log session",
  "add session note", "close session", "resume session".
argument-hint: "[sync | list | export --today | resume | note TEXT | close TEXT]"
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

## Moving vault-run sessions to a project

Sessions started from the vault for work on a code project are filed under
the vault, not the project. To move them:
- **Transcripts** go to `~/.claude/projects/<encoded repo path>/`: the
  `<id>.jsonl` and its `<id>/` folder (`subagents/*.jsonl`). Find them by
  scanning the vault project's `.jsonl` files for the repo name. Move the
  files unchanged; never rewrite `cwd` or anything else inside a transcript.
- **A still-open session can't be moved**, and Claude Code refuses to delete
  or overwrite transcript files from inside a session. Copy now and give the
  user the final `Move-Item -Force` to run after the session closes.
- **Session notes** go to `Sessions/<Project Name>/`. `session-backfill` skips
  transcripts whose `cwd` is the vault, so write those notes yourself in the
  backfill format and link them from the project note's `## Sessions`.
- If the repo's derived slug doesn't match the project note's `folder:`, add
  an override in `<vault>/.braynee/project_map.json`
  (`"my-repo": { "wikilink": "My Repo", "folder": "My Repo" }`). A repo nested
  one level deeper in `code/` derives a slug that matches nothing.
- The Stop hooks write a `type: transcript` note to `Sessions/Transcripts/`
  for vault-run sessions; move it and fix `project` / `project_folder` after
  the session closes, or the hook recreates it.

Start project sessions from the repo folder so the hooks file them under the
project from the start.

## Auto-Sync Hook

Your `~/.claude/settings.json` already has `session-export-qmd.js` and `session-auto-close.js`
on the Stop event — no additional hooks needed. Session export is already automated.

Use the `export` command manually when you want to bulk-sync historical sessions.
