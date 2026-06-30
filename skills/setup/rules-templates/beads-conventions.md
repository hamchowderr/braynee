---
paths:
  - "**"
---

# Beads — every piece of work is traceable

Beads is the source of truth for trackable work. The point is a clean, detailed
back-trace to **any** decision — not a graveyard of one-line titles. Two questions
decide everything: *"Is this trackable work?"* and *"Could I resume it in 2 weeks?"*

## What goes where

| It is… | Home |
|---|---|
| Trackable **work** — feature, bug, fix, task, chore, epic — and the decisions behind it | **beads issue** (`bd create`) |
| A durable **insight / fact** (not work) — "this API behaves like X" | **`bd remember`** (recall via `bd memories`) |
| An **ephemeral** single-session checklist | **TodoWrite** (lost after the session, by design) |
| **Personal / preference / reference / cross-project** knowledge | **vault** (Claude Memory / notes) |

Don't put work in TodoWrite (it dies on compaction). Don't put insights or
preferences in issues. And don't over-file — if a 2-weeks-away you wouldn't need
it, it's probably TodoWrite, not a bead.

## Writing an issue — five fields, distinct jobs
- **Title** — specific, action-oriented (`Fix: auth token expires before refresh`, not `Fix bug`).
- **Description** — the problem **+ why it matters**.
- **Design** (`--design`) — **HOW + the trade-offs**. This is the decision record: "chose X over Y because…". Allowed to change.
- **Acceptance** (`--acceptance`) — **WHAT success looks like**: outcome-focused, each criterion verifiable (a definite yes/no), stable even if you re-implement. *Not* steps.
- **Notes** (`--notes` / `--append-notes`) — running log + session handoffs; the compaction lifeline.

> **design-vs-acceptance test:** if you rewrote the solution a different way and a
> criterion no longer applied, it was **design**, not acceptance.
> `Use JWT` = design; `tokens persist across sessions` = acceptance.

## Keep the trace clean
- **Capture the why** in `--design` as you decide — not just what you did.
- **Reversed a decision?** `bd supersede <old> --with <new>` — link old → new. Never silently close-and-delete; the trail must show *why it changed*.
- **Found work mid-task?** `bd create … --deps discovered-from:<current>` — preserve the causal link.
- **Close with a reason:** `bd close <id> --reason "…"` — how/why it ended, with evidence.

## Discipline
- **Before coding** in a beads repo: `bd list --status in_progress` → else `bd ready` → claim atomically (`bd update <id> --claim`). Don't invent work.
- **Turn on the create-time guard** (once per repo): `bd config set validation.on-create warn` — flags new issues missing Description/Acceptance so quality can't silently drift.
- `bd lint` finds issues missing sections; `bd prime` recovers context after compaction.
