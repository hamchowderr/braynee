---
paths:
  - "**/code/**"
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

## No user-specific data in shareable artifacts
Kits, templates, and plugins ship their beads *with them* — `.beads/issues.jsonl` is
tracked, and commits carry `Closes:`/`Refs:` links into that history. So a beads issue
(title, description, design, acceptance, notes, **close-reason**) and any commit that
links one must contain **zero user-specific / private references**: real product names,
client names, private repos, or internal business context.
- When a private thing is only a design reference — "go look at *<my product>* for the
  styling" — name it by **role**, never by name: "a reference chat app," "the house
  style," "downstream products."
- Treat every kit/template/plugin repo as **public-by-default**, even before it's pushed.
- This has bitten more than once — it's a hard rule, not a preference. If names slip in,
  scrub them from issues *and* the exported `issues.jsonl` *and* commit messages.

## Discipline
- **Before coding** in a beads repo: `bd list --status in_progress` → else `bd ready` → claim atomically (`bd update <id> --claim`). Don't invent work.
- **Research before you create.** Before filing a new issue — or building it — `bd search "<keywords>"` for existing or duplicate work (and, in a repo with PRs, `gh pr list --search "<keywords>"`). If it already exists, **link** (`--deps discovered-from:`/`related:`) or `bd supersede` instead of filing a duplicate; **abort** work that's already claimed or already has an open PR. (This is the beads "check before you build" discipline.)
- **Turn on the create-time guard** (once per repo): `bd config set validation.on-create warn` — flags new issues missing Description/Acceptance so quality can't silently drift.
- `bd lint` finds issues missing sections; `bd prime` recovers context after compaction.

## Execution metadata — make an issue a dispatch spec

An issue can carry **optional** metadata that says *how* to run it, so an orchestrator
(autopilot today, a Mastra worker loop tomorrow) can pick the right agent/model/effort
**before** dispatch — without re-reading the prose. Every key is optional; **absent = use
session defaults**, so this is fully backward-compatible.

| Key | Values | Meaning |
|---|---|---|
| `execution_agent_type` | an agent/subagent type name (`braynee:autopilot`, `general-purpose`, `Explore`, `braynee:beads-auditor`, …) | who should run it |
| `execution_suggested_model` | `opus` \| `sonnet` \| `haiku` | model to launch the runner with |
| `execution_reasoning_effort` | `low` \| `medium` \| `high` | reasoning effort for the runner |
| `execution_mode` | `autonomous` \| `review` \| `plan` | latitude — run it / run-then-review / plan-only |
| `execution_parallel_group` | free-form key (e.g. `phase2-features`) | issues sharing a key may run **concurrently** |

**Write** — one key at a time (idempotent per key), or as a JSON blob at create:
```bash
bd update <id> --set-metadata execution_agent_type=general-purpose \
               --set-metadata execution_suggested_model=sonnet \
               --set-metadata execution_reasoning_effort=medium \
               --set-metadata execution_mode=autonomous \
               --set-metadata execution_parallel_group=phase2-features

bd create "…" --metadata '{"execution_agent_type":"Explore","execution_suggested_model":"haiku"}'
```

**Read** — before dispatch:
```bash
bd show <id> --json | jq '.[0].metadata'
```

**Rule — read execution metadata before prose.** A parent/orchestrator must read these keys
*before* spawning a subagent, because a running subagent cannot change its model or reasoning
effort after launch. `description` is the work scope; `notes` is rationale/fallback. Set only
keys you can justify — leave the rest unset rather than guess — and never clobber human-set
metadata on a re-run.

## Agent commits — sign the work

When an **agent** prepares a commit, leave a lightweight execution trail so `bd doctor` /
audit can attribute it — *on top of* normal attribution, not instead of it:
```text
Agent-Signature: {runtime}-{model}-{reasoning} on behalf of {git user.name}
```
Keep the `(<issue-id>)` in the subject (so `bd doctor` links the commit to its issue) and any
`Co-Authored-By:` trailer. Use **reliable runtime/session** metadata only — fall back to
`unknown-model` / `unknown-reasoning` rather than guess; never infer the model or reasoning
effort from prompt text, default settings, a cached model list, or memory.

```text
Fix token refresh race (cp-abc)

Agent-Signature: claude-code-opus-4.8-high on behalf of <git user.name>
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```
