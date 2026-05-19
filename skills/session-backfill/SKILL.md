---
name: session-backfill
description: >
  Backfill structured session summaries from Claude Code .jsonl transcripts into
  the vault's per-project Sessions folder. Distills each CC session into TL;DR /
  Goal / Outcome / Decisions / Blockers / Next / References — agent- and
  human-searchable, not raw transcripts. Use when user says "backfill sessions",
  "summarize my sessions for X", "fill in the empty session notes", or wants to
  make QMD project history actually useful.
argument-hint: '[--project NAME | --all] [--limit N] [--dry-run]'
allowed-tools: Bash(python3:*), Bash(claude:*)
---

# Session Backfill Skill

Turn empty braynee session-auto-track stubs into substantive per-project session notes by distilling the real Claude Code conversation history.

## Why

Braynee's session-auto-track creates a one-line stub session note when each CC session starts. The stubs never get filled in — they say "Waiting for user to state goal" and "(none yet)" forever. Meanwhile the actual conversation lives in `~/.claude/projects/<encoded-path>/*.jsonl`. QMD indexes only the stubs, so project history is unsearchable.

This skill reads each `.jsonl`, filters the tool-call noise, distills the conversation skeleton, and writes a structured summary into `<vault>/2. Areas/Sessions/<Project>/<date>-<slug>-<type>-<id>.md`.

Idempotent: if a structured note already exists for a `session_id`, it's skipped. Safe to rerun.

## Distillation: no API billing by default

The default backend is **`claude -p`** — it uses your local Claude Code subscription via OAuth. **No `ANTHROPIC_API_KEY`, no Console credits, no infisical, no per-session cost.** The script explicitly strips `ANTHROPIC_API_KEY` from the `claude -p` subprocess env so it can never silently fall back to API billing.

`--use-api` is an explicit opt-in for the raw Anthropic API (Console credits). Use it only if you specifically want API billing and have set `ANTHROPIC_API_KEY` yourself. It is never required and never the default.

## Commands

```bash
# Single project (pilot use) — uses `claude -p`, no API billing
python3 {baseDir}/scripts/backfill.py --project sophon-webapp

# Dry run — print what would be created, no distillation at all
python3 {baseDir}/scripts/backfill.py --project sophon-webapp --dry-run

# Limit to N most-recent sessions per project
python3 {baseDir}/scripts/backfill.py --project foreman --limit 5

# All projects (the big backfill)
python3 {baseDir}/scripts/backfill.py --all

# Point at a non-default vault location
python3 {baseDir}/scripts/backfill.py --all --vault "/path/to/Obsidian Vault"

# Opt in to the raw API (Console billing — only if you explicitly want it)
ANTHROPIC_API_KEY=... python3 {baseDir}/scripts/backfill.py --project foreman --use-api
```

## Vault resolution

The vault is resolved universally, no hardcoded path:

1. `--vault PATH` argument
2. `$BRAYNEE_VAULT` / `$OBSIDIAN_VAULT` environment variable
3. Common locations probed for a `.obsidian` directory (`~/Obsidian Vault`, `~/vault`, `~/Documents/Obsidian Vault`, OneDrive / iCloud variants)
4. Falls back to `~/Obsidian Vault` so a brand-new vault still works

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
tags:
  - session
  - debug
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

Claude Code stores each project under `~/.claude/projects/<encoded-path>/`, where the encoded path is the project's absolute path with separators (and the Windows drive colon) replaced by `-`. The skill derives the project slug generically — it strips a leading Windows drive letter, then takes the path segment after the last recognised parent directory token (`code`, `src`, `work`, `repos`, `dev`, …). This works for any user on any OS regardless of where their code lives.

For projects where the derived slug doesn't map to a clean wikilink (e.g., `dealreveal-engine` → `DealReveal`, not `Dealreveal Engine`), add an override in `scripts/project_map.json`. Overrides are optional — without them the slug is title-cased word-by-word.

## Requirements

- **Python 3.10+** — that's it for the default path.
- **`claude` CLI on PATH** (Claude Code) — used for distillation via your subscription. Already present wherever this skill runs.
- Optional: `pip install anthropic` **only** if you pass `--use-api` (raw API, Console billing).
- No infisical, no secrets manager, no API key needed for normal use.

## Cost

- Default (`claude -p`): consumes your Claude Code subscription quota, **no API dollar cost**.
- `--use-api` (opt-in only): `claude-sonnet-4-6`, prompt-cached system prompt, ~$0.02/session on Console credits.
