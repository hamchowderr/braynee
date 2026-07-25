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

## Releasing — three phases. Never one release per fix.

A release is a **batch operation**, not the reflex after a fix. Each release burns
a version number, a CI run, a cache stage, and — the part that actually costs the
user — a Claude Code restart. On 2026-07-25 three releases shipped in one session
(2.1.19 → 2.1.21), one per fix, with two restarts. That is the anti-pattern this
section exists to prevent.

**Phase 1 — WORK (repeat freely, no version anything).**
For each issue: fix → gate → commit to `main` with the issue id in the subject.
- Gate = `node bin/braynee-self-test`. Add layer 2 (`scripts/hook-sandbox.mjs`)
  whenever `hooks.json` or a hook's CC-boundary behavior changed.
- **Do NOT** bump `plugin.json`/`marketplace.json`, tag, run the release workflow,
  or touch the plugin cache. Commits accumulate; that is the point.
- Multiple issues land as multiple commits. Ten fixes = ten commits = still zero
  releases.

**Phase 2 — RELEASE (once per batch, only when the user says ship / the batch is
done / the session is wrapping).**
1. Confirm `git status` clean and `git rev-list --left-right --count origin/main...HEAD`
   is `0 0`.
2. **Verify cross-platform BEFORE tagging** — the release workflow runs the gate on
   Linux, so a Windows-only pass is not evidence:
   `wsl.exe -d Ubuntu bash -lc "cd /mnt/c/Users/HamCh/code/braynee && node bin/braynee-self-test"`
3. Bump `.claude-plugin/plugin.json` **and** `.claude-plugin/marketplace.json`
   together; commit.
4. `claude plugin tag .` — validates that the two agree, runs plugin validation,
   and refuses a dirty tree. Gitignore stray runtime files rather than `--force`.
5. `git push origin main` then `git push origin refs/tags/braynee--v<ver>`. The
   **tag push** is what publishes; a bump alone reaches nobody, and the
   zip/`--plugin-url` path only ever updates on a tag.
6. Confirm the run succeeded and the release has its `braynee.zip` asset. If it
   failed, **delete the tag (local + remote), fix, re-tag the same version** —
   nothing was published, so the number is still free.

**Phase 3 — DEPLOY to this machine (once, right after the release).**
Stage the cache dir, flip the registry, verify, then ask for **one** restart.
Full procedure and its traps in the `feedback-plugin-direct-cache-deploy` memory.
Write the registry from a **script file**, never inline `node -e` (Windows paths
lose their backslashes to shell escaping), and assert `fs.existsSync` on the
`installPath` you just wrote — a mangled path makes CC load no plugin at all,
silently.

**Choosing when to cut a release:** the user asking to ship, a coherent batch
being finished, or the session wrapping up. Not "a fix passed its gate."

**Hotfix exception — needed live NOW, mid-batch:** copy the changed file(s) into
the CURRENT cache version dir and restart. No bump, no tag. The cache keeps its
old version number running newer code, which is harmless locally and is
superseded cleanly by the next real release.

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

When the user *does* authorize shipping, that authorization is for a **batch**:
follow the three phases above. "Ship it" after one fix does not mean cut a
release per subsequent fix — keep committing (phase 1) and cut one release
(phase 2) when the batch is done.

If approval rules block a commit/push the user asked for, say so explicitly —
don't narrate the work as if it shipped.
