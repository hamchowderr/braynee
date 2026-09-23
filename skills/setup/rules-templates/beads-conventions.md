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
- **Found work mid-task?** `bd create "…" --design "…" --acceptance "…" --deps discovered-from:<current>` — preserve the causal link.
- **Close with a reason:** `bd close <id> --reason "…"` — how/why it ended, with evidence.

## No user-specific data in shareable artifacts
A beads tracker travels with its repository. The whole database — issues, close reasons,
**memories** — is pushed to **`refs/dolt/data`** on the git remote, and commits carry
`Closes:`/`Refs:` links into that history. That ref is invisible (not a branch, absent
from the host's web UI, not fetched by a plain `git clone`) and nonetheless readable by
anyone who can read the repo. So a beads issue (title, description, design, acceptance,
notes, **close-reason**), anything stored with `bd remember`, and any commit that links
one must contain **zero user-specific / private references**: real product names, client
names, private repos, or internal business context.
- When a private thing is only a design reference — "go look at *<my product>* for the
  styling" — name it by **role**, never by name: "a reference chat app," "the house
  style," "downstream products."
- Treat every repo whose beads could ever be published as **public-by-default**, even
  before it's pushed — kits, templates and plugins always, product repos the moment
  open-sourcing is on the table.
- **Deleting does not remove.** Dolt keeps history like git. `bd forget` and `bd delete`
  write a *new* commit without the row; every earlier commit still holds it, on the
  remote too. Check with
  `dolt sql -q "select count(*) from dolt_history_<table> where …"`. Scrubbing after the
  fact takes `bd flatten --force` (all history) or `bd compact --days N --force` (older
  than N days), plus a force push — a delete on its own does nothing.
- This has bitten more than once — it's a hard rule, not a preference. If names slip in,
  scrub them from issues *and* the exported `issues.jsonl` *and* commit messages *and*
  the Dolt history.

## Discipline
- **Before coding** in a beads repo: `bd list --status in_progress` → else `bd ready` → claim atomically (`bd update <id> --claim`). Don't invent work.
- **Research before you create.** Before filing a new issue — or building it — `bd search "<keywords>"` for existing or duplicate work (and, in a repo with PRs, `gh pr list --search "<keywords>"`). If it already exists, **link** (`--deps discovered-from:`/`related:`) or `bd supersede` instead of filing a duplicate; **abort** work that's already claimed or already has an open PR. (This is the beads "check before you build" discipline.)
- **The create-time guard is on** (once per repo): `bd config set validation.on-create error` — `bd create` refuses an issue missing the sections its type needs (Acceptance Criteria for tasks, features and stories; also Steps to Reproduce for bugs; Success Criteria for epics), and chores go through. braynee sets it on `bd init` and `/braynee:health` repairs it when off. Create with the sections: `bd create "Title" --design "<how + trade-off>" --acceptance "<verifiable outcomes>"`.
- **A claim needs a plan.** braynee's claim gate refuses `bd update <id> --claim` / `--status in_progress` while `bd lint <id>` reports missing sections, or while the acceptance is still the line `prd-seed` wrote. Fill them with `bd update <id> --design ... --acceptance ...` first. `bd mol pour` does not run the create-time guard, so poured steps meet this gate at claim time. bd drops a formula step's `acceptance`/`design` keys, so a formula passes only when each step's `description` carries the headings itself (`## Acceptance Criteria`, plus `## Design` where there is a real approach) — braynee's shipped formulas do.
- `bd lint` finds issues missing sections; `bd prime` recovers context after compaction.
- **`bd prime` is a subset, not the index.** It lists ~40 commands and omits `query`,
  `graph`, `epic`, `swarm`, `gate`, `provenance`, `federation`, `compact`, `flatten` and
  `gc`. Never conclude a capability is missing because it wasn't injected — run
  `bd --help`, then `bd <command> --help`, before hand-rolling anything beads already does.

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

bd create "…" --design "…" --acceptance "…" --metadata '{"execution_agent_type":"Explore","execution_suggested_model":"haiku"}'
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

## Backups — configuring is not protecting

Issue history lives in a local Dolt database. Without a recovery path, one
corrupting unclean shutdown loses it.

**Default posture: a Dolt-native backup destination outside the project.**

```bash
node <braynee>/scripts/beads-dr.mjs              # audit, read-only
node <braynee>/scripts/beads-dr.mjs --init --sync   # configure + populate
```

Destination is `~/beads-backups/<repo>`, deliberately **outside** the repo —
an in-project `.beads/backup` dies with `rm -rf <project>`, which is a likelier
way to lose a repo than disk failure. New projects get this automatically at
`bd init`.

Scope is measured, not curated: a repo qualifies when it has issue history and a
database. Backing up an empty scaffold protects nothing and buries the repos
that matter in the report.

### The trap: two different "backup" numbers

`bd backup status` prints both, and the reassuring one is not the one that
protects you:

| Line | What it is | Runs by itself? |
|---|---|---|
| `Last backup:` | bd's internal auto-backup, on by default when a git remote is detected | yes, every 15m |
| `Last sync:` | the Dolt-native **destination** — the actual recovery path | **no, `bd backup sync` is manual** |

A destination nobody pushes to rots silently while `Last backup` still reads
minutes. Measured on one fleet: 107 repos held archives that *looked* like
coverage, most 23 days stale. Whatever adopts this must run `bd backup sync` on
a schedule — braynee does it daily from a SessionStart hook.

Also note `Database size:` is a **global** figure. The same number prints in
repos with no destination at all; it is not this repo's backup size.

### What this does and does not survive

Survives DB corruption and unclean-shutdown journal damage. **Does not survive
losing the disk** — the backup sits on the same drive. Off-machine protection
needs a Dolt remote, which stays opt-in per project rather than mandatory.

A backup you have never restored is a hypothesis. Verify with
`scripts/beads-dr-verify.mjs`, which restores into a throwaway directory and
compares issue counts. It refuses to report success unless the probe is provably
isolated — a check that cannot prove isolation must never claim a restore worked.
