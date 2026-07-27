---
paths:
  - "**/code/**"
---

# Commits & PRs — one change, one story

A **commit** is one saved change. A **PR** is a branch — a bundle of 1..N commits
telling one story. These are different units, and conflating them is the usual
source of unreviewable pull requests: a 250-commit branch is still **one**
squash-merged commit on main. Commit count and PR count are unrelated.

## Commit subject — Conventional Commits

```
type(scope)!: summary
```

| Type | Use for | Release |
|---|---|---|
| `feat` | new user-visible capability | minor |
| `fix` | bug fix | patch |
| `perf` | faster/lighter, same behavior | patch |
| `refactor` | restructure, no behavior change | — |
| `test` | tests only | — |
| `docs` | docs only | — |
| `build` / `ci` | build system, pipelines | — |
| `chore` | housekeeping | — |
| `style` | formatting only, no code change | — |
| `revert` | undo a previous commit | — |

Breaking changes: `feat!:` / `feat(api)!:`, or a `BREAKING CHANGE:` footer. Either
one means a **major** bump.

## The 50/72 rule

- Subject **≤50 chars**, **imperative** mood — "add", not "added" or "adds".
  Read it as *"if applied, this commit will …"*.
- Blank line.
- Body wrapped at ~72 — **what** changed and **why**, not *how*. The diff already
  says how; it can never say why.

## Atomic commits

One logical change per commit. Each one builds and passes **on its own** — that is
what makes `git bisect`, `git revert`, and cherry-picking work at all.

No `wip`, `fix typo`, `oops`, `address review` noise. If it happened while you
worked, squash it before merge.

## Branches

`feature/`, `fix/`, `chore/` — prefixed by type. **Never commit straight to
`main`/`master`.** (Some repos intentionally ship direct-to-main; those opt out
explicitly rather than by habit.)

## Grouping a PR

One coherent story. Several small related issues may ride together, one commit
each, if they serve that story.

Group by the **story**, not the folder — *same surface, not same directory*.

> **The "and" test:** if you cannot name the PR without saying "and", it is two PRs.

Type the PR by its **highest-impact** commit: `feat` > `fix` > `refactor`/`perf` >
`test`/`chore`/`docs`. Don't default everything to `feat`.

## Sizing

Keep the diff reviewable in one sitting — roughly **200–400 LOC**, under ~60
minutes. Past that, split or stack the PRs.

This is not taste. In the SmartBear/Cisco study of ~2,500 reviews (Jason Cohen,
*Best Kept Secrets of Peer Code Review*, 2006), defect detection drops sharply
beyond ~200–400 LOC, above ~500 LOC/hour, or past ~60 minutes of review. A bigger
PR does not get reviewed more slowly — it gets reviewed *worse*.

## Merging

- **Squash-merge** — the default. Collapses a branch's internal commits into one
  clean commit on main.
- **Rebase-merge** — when every commit is genuinely atomic and worth keeping
  linear.
- **Merge commit** — noisiest; use when you need the branch topology preserved.

## What this unlocks

Following the format is what lets tooling work at all:

- **commitlint + husky** — reject a malformed message at commit time
- **commitizen** — interactive prompt instead of remembering the grammar
- **release-please / semantic-release / conventional-changelog** — changelog and
  semver derived from commit types, with no hand-maintained list

## Enforcement — three layers, deliberately different in strength

| Layer | Covers | Malformed subject/title | Size, mood, traceability |
|---|---|---|---|
| Claude-side hook | commits the agent makes | blocked | reported |
| `commit-msg` hook | every committer in the clone | rejected | warned |
| PR-title CI job | the title that lands on main | fails the check | warning annotation |

Only the **mechanical** failure — not Conventional Commits form — is ever hard-
blocked. It is unambiguous and fixable by rewording. Everything requiring
judgement is reported instead: a guard that fires on correct work is one people
switch off, and then it protects nothing.

The agent-side layer is automatic. The other two are **opt-in per repo** — commit
conventions on a repo with existing history and other people's workflows is a
decision, not a default.

### Adding the git-side layers to an existing repo

```bash
node <braynee>/scripts/install-commit-hooks.mjs --repo . --dry-run   # preview
node <braynee>/scripts/install-commit-hooks.mjs --repo .             # install
```

Then run the dependency-install command it prints. It is idempotent, keeps its
section between markers so re-running never duplicates it, and **never
overwrites an existing `commit-msg` hook** — it appends alongside. Repos with no
`package.json` get an equivalent dependency-free shell check instead.

The PR-title and PR-size jobs come from `gen-ci-workflow.mjs` (`--no-pr-lint`
opts out).

If the repo uses **beads**, these coexist: beads owns `pre-commit`,
`post-merge`, `pre-push`, `post-checkout` and `prepare-commit-msg` — never
`commit-msg`. Since `prepare-commit-msg` runs first, beads' trailers are already
in the message commitlint validates, which is why the generated config leaves
footer length unrestricted.

### Turning it off

```bash
git config --local braynee.allow-freeform-commits true   # agent-side hook
```

Per-repo and settable mid-session, for repos that intentionally use free-form
messages.

## Traceability

Reference the tracked work in the commit body or footer, so a commit can always be
traced back to the issue that motivated it — and the issue forward to what shipped
it. See the beads conventions rule for how work is tracked.
