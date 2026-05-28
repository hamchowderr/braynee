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

## No PRs. No pushes. Test in a directory.

The CC plugin docs do **not** require a PR or even a remote to install/use a
plugin — `--plugin-dir <source>` loads it straight from disk. Stop treating this
repo like a published library that needs a PR per change.

**Default workflow for any change here:**
1. Edit source in this repo.
2. Verify in the live sandbox via `node scripts/hook-sandbox.mjs` →
   `claude --plugin-dir <source> --debug-file <jsonl>` (the layer-2 path above).
   Optionally also run `node bin/braynee-self-test` for layer-1 assertions.
3. If the fix is wanted on the live install right now, copy the changed file(s)
   into `~/.claude/plugins/cache/braynee/braynee/<version>/` and restart CC.
4. **Stop there.** Do not `git commit`, `git push`, or `gh pr create` unless the
   user explicitly says so in this session.

A passing sandbox run is "done" for braynee work. Committing/pushing/opening a
PR are separate, user-authorized actions — never bundled in by default, never
proposed as the next step.

If approval rules block a commit/push the user asked for, say so explicitly —
don't narrate the work as if it shipped.
