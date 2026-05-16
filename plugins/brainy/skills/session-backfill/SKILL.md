---
name: session-backfill
description: >
  Backfill structured session summaries from Claude Code .jsonl transcripts into
  the vault's per-project Sessions folder. Distills each CC session into TL;DR /
  Goal / Outcome / Decisions / Blockers / Next / References — agent- and
  human-searchable, not raw transcripts. Use when user says "backfill sessions",
  "summarize my sessions for X", "fill in the empty session notes", or wants to
  make QMD project history actually useful.
argument-hint: [--project NAME | --all] [--limit N] [--dry-run]
allowed-tools: Bash(python3:*), Bash(infisical:*)
---

# Session Backfill Skill

Turn empty brainy session-auto-track stubs into substantive per-project session notes by distilling the real Claude Code conversation history.

## Why

Brainy's session-auto-track creates a one-line stub session note when each CC session starts. The stubs never get filled in — they say "Waiting for user to state goal" and "(none yet)" forever. Meanwhile the actual conversation lives in `~/.claude/projects/<path>/*.jsonl` (~3,300 files, ~96% never imported to the vault). QMD indexes only the stubs, so project history is unsearchable.

This skill reads each .jsonl, filters the tool-call noise, sends the conversation skeleton to Claude API, and writes a structured summary into `2. Areas/Sessions/<Project>/<date>-<slug>-<type>.md`.

Idempotent: if a structured note already exists for a session_id, it's skipped. Safe to rerun.

## Commands

```bash
# Single project (pilot use)
infisical run -- python3 {baseDir}/scripts/backfill.py --project sophon-webapp

# Dry run — print what would be created without API calls
python3 {baseDir}/scripts/backfill.py --project sophon-webapp --dry-run

# Limit to N most-recent sessions per project
infisical run -- python3 {baseDir}/scripts/backfill.py --project foreman --limit 5

# All projects (the big backfill — expect ~$60-100 in API costs)
infisical run -- python3 {baseDir}/scripts/backfill.py --all
```

## Note format produced

Every backfilled note follows this structure:

```markdown
---
type: session
project: "[[Sophon Webapp]]"
status: done
session_type: debug
session_id: "66b42f24-..."
started: 2026-04-27T09:01:00Z
tags: [session, debug]
---

## TL;DR
[1-2 sentences — state of work + outcome]

## Goal
[What this session was trying to accomplish]

## Outcome
- **Shipped:** concrete changes that landed
- **In flight:** things started but not finished

## Decisions
- **[Decision]** — rationale, tradeoff

## Blockers / Open Questions
- [Things stuck, waiting, unknown]

## Next
[Single highest-leverage next action]

## References
- **Files:** `path/to/file.ts`
- **Related:** [[wikilinks]]
```

## Project name mapping

CC project folders are kebab-case (`sophon-webapp`). Vault session folders are Title-Kebab (`Sophon-Webapp/`). Project wikilinks are Title Case With Spaces (`[[Sophon Webapp]]`).

For projects where the CC folder name doesn't map cleanly (e.g., `dealreveal-engine` → `DealReveal`, not `Dealreveal Engine`), override in `scripts/project_map.json`.

## Cost

- Model: `claude-sonnet-4-6` (fast + cheap, sufficient quality for summarization)
- Prompt caching on the system prompt — first session in a batch pays full price, rest use cache
- Average: ~$0.02 per session
- Full backfill (3,329 sessions): ~$60-100

## Requirements

- `ANTHROPIC_API_KEY` env var (use `infisical run --` to inject)
- `pip install anthropic` (Python SDK)
- Python 3.10+
