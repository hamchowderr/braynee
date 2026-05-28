---
name: pour
description: >
  Pour a beads workflow formula — turn a recipe into a linked, gated
  molecule of beads issues with one command. Walks the user through
  picking a formula (project, engagement, braynee-release) and supplying
  its vars, then runs `bd mol pour`. Use when the user says "pour",
  "start a project", "new client engagement", "ship a release",
  "kick off X", "spin up a workflow", or "/braynee:pour".
argument-hint: "[project | engagement | braynee-release] (or no args to pick from a menu)"
allowed-tools: Bash(bd:*)
---

# Pour — beads workflow formula launcher

Formulas are recipes for multi-step work. `bd mol pour <formula>` creates
the whole molecule of linked, gated beads issues in one shot — no manual
`bd create` / `bd dep add` sequence.

This skill is the friendly menu in front of that command. It picks the
formula, collects the vars via AskUserQuestion, dry-runs first to confirm,
then pours for real.

## Available formulas (canonical)

Always re-list with `bd formula list` before showing the user — formulas
can be added or removed.

| Formula | Use when |
|---|---|
| **project** | Your own work. Internal projects, no client coordination. 4 steps: scope → build → qa → ship. |
| **engagement** | Paid client work. 7 steps: discovery → scope → build → qa → review → ship → handoff. Two human gates (discovery, review). |
| **braynee-release** | Shipping a new braynee plugin version. 4 steps: selftest → sandbox → deploy-cache → bump. No PR. |

## Workflow

### 1. Pick a formula
- If the user passed an argument (`/braynee:pour engagement`), use that.
- Otherwise call `bd formula list` to show the live list, then use
  AskUserQuestion to ask which one.

### 2. Show what it does, then collect vars
- Run `bd formula show <name>` so the user can see the steps and vars
  before they commit.
- Use AskUserQuestion to collect each required var. Mark optional vars as
  such — let the user skip them.

**Required vars per formula** (verify with `bd formula show` — this is a
quick reference, the formula files are authoritative):

| Formula | Required | Optional |
|---|---|---|
| project | `name`, `deliverable` | — |
| engagement | `client`, `deliverable` | `reference` |
| braynee-release | `version` (semver `X.Y.Z`) | — |

### 3. Dry-run first
ALWAYS dry-run before pouring for real:

```bash
bd mol pour <formula> --var key="value" ... --dry-run
```

Show the list of issues that would be created. Ask the user to confirm
before re-running without `--dry-run`.

### 4. Pour for real
On confirmation, drop `--dry-run`:

```bash
bd mol pour <formula> --var key="value" ...
```

Report the molecule ID and the IDs of the newly-ready issues. Suggest the
user run `bd ready` to see what's actionable now.

## After pouring

The molecule's issues are real beads issues — they work with everything
beads already does:
- `bd ready` shows unblocked issues (only the first step + any non-gated
  parallel steps will appear).
- `bd update <id> --claim` claims one to work on.
- Human gates need `bd gate resolve <id>` when the human checkpoint
  (discovery call held, client signed off, etc.) is done.
- Timer / `gh:run` gates auto-advance via the braynee `beads-gate-check`
  Stop hook — no manual polling.

## Var quoting reminders

PowerShell and bash both expand differently. The pattern that works
everywhere:

```bash
bd mol pour engagement \
  --var client="Acme Co" \
  --var deliverable="Mastra RAG agent over their docs"
```

If a var value contains a quote, switch the outer quoting style or
escape with `\"`. Watch for stray semicolons in step descriptions —
beads will accept them but they look weird in `bd show <id>`.

## When NOT to use this skill

- If the user is working a single discrete task, `bd create` directly is
  lighter than pouring a whole molecule.
- If the formula concept doesn't fit — they want a one-off issue, not a
  recipe — don't force a formula.

Formulas are for **recurring shapes of work**. Use them when you'd
otherwise be typing the same `bd create` sequence for the third time.
