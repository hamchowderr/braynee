---
name: granola
description: >
  Sync Granola AI meeting notes to Obsidian vault.
  Reads from local cache — no API needed.
  Use when user says "meeting notes", "granola", "sync meetings",
  "add meeting to vault", "transcripts", "what did we discuss".
argument-hint: [list | sync | sync --id ID | get ID]
allowed-tools: Bash(python3:*)
---

# Granola Skill

Sync Granola meeting notes and transcripts to Obsidian.

## How It Works

Granola stores everything locally at:
- **Mac:** `~/Library/Application Support/Granola/cache-v3.json`

No API key needed. Reads directly from the cache file in real-time.

## Commands

```bash
# List all meetings with sync status
python3 {baseDir}/scripts/granola.py list

# List recent meetings
python3 {baseDir}/scripts/granola.py list --limit 10

# View a specific meeting
python3 {baseDir}/scripts/granola.py get <id>

# Sync all new meetings
python3 {baseDir}/scripts/granola.py sync

# Sync a specific meeting
python3 {baseDir}/scripts/granola.py sync --id <id>

# Re-sync everything
python3 {baseDir}/scripts/granola.py sync --all
```

## Output

Synced meetings go to `{vault}/2. Areas/Business/{company}/Transcripts/`:

```markdown
---
type: meeting
date: 2026-05-04
duration_min: 45
granola_id: abc123
people:
  - "[[Person Name]]"
status: raw
---

# Meeting Title

## Notes
(Granola notes)

## Transcript
[10:30:00] 🎤 Hey, let's get started...
[10:30:05] 🔊 Sounds good...
```

Status lifecycle: `raw` → `processed`
