# Beads hook ownership: braynee vs bd

Two hook layers act on the same repos (cp-uif3.6). braynee's Claude Code hooks
see what the **agent** does: tool calls, session boundaries. bd's git hooks
(`bd hooks install`, managed sections in `.beads/hooks/`, `core.hooksPath`) see
what **git** does, for every committer. This page records which layer owns each
concern, so a change in one doesn't silently duplicate or fight the other.

Verified against bd 1.3.4 and beads source `cmd/bd/hooks.go` (2026-11-27).

## What bd's git hooks actually do

| git hook | bd behaviour |
|---|---|
| `pre-commit` | runs a chained hook, then exports `issues.jsonl` for the commit |
| `post-merge` | chained hook, then imports `issues.jsonl` |
| `post-checkout` | chained hook; on a branch switch with no Dolt remote, imports `issues.jsonl` |
| `pre-push` | chained hook only |
| `prepare-commit-msg` | appends `Executed-By: <actor>` **only when `BD_ACTOR` is set**; skips merges and messages that already have one |
| `commit-msg` | not touched by bd; braynee's commitlint section owns it (`scripts/lib/commit-hooks-core.js`) |

bd ships no branch naming, no protected-branch guard, no commit cadence, no
close gating and no status mirroring. Those are braynee's alone.

## Ownership map

| Concern | Owner | Notes |
|---|---|---|
| Branch on claim | braynee `beads-claim-to-branch.js` | bd has no equivalent. |
| No work on `main` | braynee `check-no-main-push.js` | Agent-side only. Humans are covered by GitHub rulesets, not a git hook. |
| Branch name format | braynee `branch-name-check.js` | Warning only. |
| Commit message format | braynee `commit-format-check.js` (agent) + braynee commitlint on `commit-msg` (everyone) | bd's trailer lands first (prepare-commit-msg runs before commit-msg), so commitlint must accept trailers; it does. |
| Agent identity on **bd changes** | braynee `beads-actor-sign.js` (`--actor claude` / `claude/<type>`) | bd records it; braynee only supplies the value. |
| Agent identity on **commits** | **bd** `prepare-commit-msg` | braynee only sets `BD_ACTOR=claude` in Claude's shell (`beads-commit-actor.js`, via `$CLAUDE_ENV_FILE`). No braynee commit hook writes `Executed-By`. |
| `Agent-Signature:` trailer (runtime/model/effort) | the agent, by convention (`beads-conventions`) | Different content from `Executed-By`; both can appear. |
| Commit cadence | braynee `commit-cadence-nudge.js` | |
| Verify before close | braynee `beads-close-gate.js` | |
| Plan before claim | braynee `beads-claim-gate.js` + bd `validation.on-create=error` (set by `check-beads-init.js`) | bd refuses an issue without sections at create; braynee refuses a claim on one that was never planned. Complementary, not duplicate. |
| Status mirror (session note, active-issue.json, TodoWrite) | braynee `beads-status-sync.js`, `beads-todo-reminder.js` | |
| PR ↔ issue link | braynee `beads-pr-external-ref.js` + `pr-standards.yml` in CI | |
| `issues.jsonl` freshness | **bd** (`export.auto: true` + `pre-commit` export) | braynee's `check-beads-init.js` only makes sure `export.auto` is on. |
| Backups | braynee `beads-dr-sync.js` / `scripts/beads-dr.mjs` | bd's backup is manual; braynee schedules it. |
| Merge-queue serialisation | **bd** `merge-slot` | Used by `agents/autopilot.md` around the rebase step. braynee filters the `gt:slot` bead out of its work surfaces. |

### Superseded by native bd behaviour

- None of braynee's hooks wrote `Executed-By` themselves, so nothing is removed;
  the trailer now comes from bd and braynee only provides `BD_ACTOR`.
- The "stale `issues.jsonl`" workaround is gone since cp-uif3.1: bd's own
  `export.auto` and `pre-commit` export keep it current.

No duplication or conflict was found. The one ordering dependency is the one
above: bd's trailer is written before commitlint validates the message.

## Is reading `issues.jsonl` still worth it?

`hooks/lib/read-issues-jsonl.js` exists so routine hooks (Stop, PostToolUse,
statusline) read a file instead of spawning `bd`. Its original premise was load
on the shared Dolt server. That premise has weakened: repos now run embedded
Dolt (`dolt_mode: embedded` in `metadata.json`), and `export.auto` keeps the
file fresh. But the reasons that remain are still sufficient:

- An embedded Dolt database takes a process lock. Several Claude Code sessions
  in one repo, each running `bd list` on every Stop, contend on it.
- A file read costs no process spawn, where `bd` costs 100+ ms per call even warm.
- The file is repo-scoped by construction (the cp-o4g `--all` trap can't happen).

So the design stays: file reads for frequent read-only hooks; live `bd` only
where freshness to the last write matters (claim and close gates, work surface
at session start).

## JSON envelope (beads v2.0)

`BD_JSON_ENVELOPE=1` wraps every `--json` payload as
`{"data": <payload>, "schema_version": 1}`; it becomes the default in v2.0. A
legacy-only parser doesn't fail on it, it reads an empty list and goes quiet.
Every `bd --json` read in braynee now goes through `hooks/lib/bd-json.js`
(`parse`, `parseList`), or an equivalent inline `unwrapBd` in the board scripts,
which accept both shapes. `hooks/lib/bd-json.test.js` runs the installed bd in
both modes and checks they parse the same.
