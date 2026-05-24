# braynee — project instructions

braynee is an Obsidian second-brain Claude Code plugin (TypeScript/Node, hooks +
skills + agents). It is installed as a local CC plugin; the live install runs from
`~/.claude/plugins/cache/braynee/braynee/<version>/`, the source is this repo.

## Hooks: never gate with the `if` field — self-gate in JS

The Claude Code hook `if` field (permission-rule syntax like
`"if": "Bash(bd create *) || Bash(bd close *)"`) is **version-unreliable** and must
not be used. Verified live on 2026-05-24 (cp-068):

- **CC 2.1.143**: any `if`-bearing hook **never fires** — even a single-pattern
  `"if": "Bash(bd *)"`. This silently broke the three-way task mirror
  (`beads-todo-reminder` never emitted its reminder) and would disable the
  no-push-to-main guard.
- **Older CC**: the `if` field is **ignored**, so the hook fires on *every* Bash
  command (and duplicated registrations fire N times).

**Rule:** register Bash hooks with only `"matcher": "Bash"` (no `if`) and gate
inside the hook's JS — match the command with a regex and `process.exit(0)` early
on a non-match, before any side effect. Every gated hook here already does this
(`beads-todo-reminder`, `beads-status-sync`, `commit-cadence-nudge`,
`beads-claim-to-branch`, `beads-dashboard-refresh`, `mtn-to-beads-sync`,
`check-no-main-push`, `branch-name-check`).

## Testing hooks — two layers

Hook bugs split into "JS logic" and "the CC↔hooks.json boundary" (firing,
`additionalContext` delivery). The boundary class is invisible to any test that
pipes synthetic stdin into a hook — that's how the `if`-field bug shipped. So use
both layers:

### 1. Headless assertions — `bin/braynee-self-test` (CI)
`node bin/braynee-self-test` runs in CI (Ubuntu/macOS/Windows, Node 20/22).
Section 8 ("Gated-hook output assertions") feeds matching and non-matching command
JSON to each gated hook and asserts **emit on a match, silence on a non-match** —
locking the self-gating contract above. Add an assertion here whenever you add or
change a gated hook. Catches JS/regex regressions; does **not** exercise CC.

### 2. Live sandbox — `scripts/hook-sandbox.mjs`
`node scripts/hook-sandbox.mjs` scaffolds a throwaway git+`.beads` repo and prints
a `claude --plugin-dir <source> --debug-file <jsonl>` command. This is the solid,
end-to-end way to confirm a change **before** it touches the live install:
`--plugin-dir` loads the plugin straight from source — **no cache copy, no version
bump, no restart**. Inside that session, run real `bd`/`git` commands, then verify:
- **hook fired** → `grep` `~/.claude/braynee-hooks.log` at your timestamps;
- **model saw it** → read the `--debug-file` JSONL for the `additionalContext` in
  the tool result.

The firing check is auto-assertable from the log; the model-delivery check is
human-eyeballed (it's CC-internal). Use a `--dir` under a git worktree to test a
new version fully isolated from your working checkout.

## Deploying a fix to the running install without a release
For an immediate fix on the live install, copy the changed source file(s) into the
running cache dir (`~/.claude/plugins/cache/braynee/braynee/<version>/`) and restart
CC. A `hooks.json` change requires a restart to take effect.
