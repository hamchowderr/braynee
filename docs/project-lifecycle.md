# Project Lifecycle

The flow braynee assumes — vault for thinking, code for doing, beads for
tracking. Hooks bind them together.

```
                        VAULT MODE                              CODE MODE
                                                            (in ~/code/<slug>/)
┌──────────────┐    ┌──────────────┐    ┌──────────────┐   ┌──────────────┐
│  Brainstorm  │ →  │  Draft PRD   │ →  │  Seed Beads  │ → │   Build      │
│ (Inbox/,     │    │ (PRDs/<Name> │    │ (prd-seed)   │   │ (claim/work/ │
│  1.Projects/)│    │  schema)     │    │              │   │  close)      │
└──────────────┘    └──────────────┘    └──────────────┘   └──────────────┘
       ↑                                                          ↓
       └────────────────── feedback / new ideas ──────────────────┘
                                                                  ↓
                                                          ┌──────────────┐
                                                          │   Ship MVP   │
                                                          │ → Roadmaps/  │
                                                          └──────────────┘
```

## What happens at each step

### 1. Brainstorm (vault)
- Capture in `Inbox/`, promote to `1. Projects/<Name>.md` when worth pursuing
- Free-form. Link liberally.

### 2. Draft PRD (vault)
- `node skills/prd/scripts/prd-new.mjs "<Name>"` scaffolds the file
- Fill in scope, milestones, **Acceptance Criteria**
- See [PRD authoring](./prd-authoring.md)

### 3. Seed Beads (bridge)
- `node scripts/prd-seed.mjs "<Name>"` parses Acceptance Criteria → creates one bd issue per line
- PRD frontmatter flips `seeded: true`, records `seeded_at` + `seeded_count`

### 4. Build (code)
- `cd ~/code/<slug>/` and start a Claude session
- Hooks fire automatically:
  - `check-git-init` — runs `git init -b main` if missing
  - `check-beads-init` — runs `bd init` if missing
  - `session-auto-track` — creates session note + surfaces PRD context
- Workflow per issue: `bd update <id> --claim` → edits → `bd close <id>`
- Braynee auto-mirrors bd ↔ TaskNotes, branches on claim (if enabled), nudges to commit every 15 closed issues

### 5. Ship + Evolve
- Once MVP is shipped, the PRD is a historical artifact
- Move ongoing planning to `2. Areas/Product Manager/Roadmaps/`
- Or open a `<Name>-V2.md` PRD if the next major scope is large enough to warrant it

## Two modes, one source of truth

- **Vault mode** = thinking. Brainstorming, PRDs, research, client notes, daily notes.
- **Code mode** = doing. Beads issues, git, edits, tests, commits.
- **Beads is the source of truth for work.** Sessions log what happened, but bd issues are the unit of accomplishment.

## When something feels off

- Vault has a project but no PRD → you skipped step 2. Stop and write one.
- PRD exists but `seeded: false` and you've already started coding → you skipped step 3. Run `prd-seed`.
- Lots of edits, no bd issue claimed → you skipped step 4. Either claim something or `bd create` first.
