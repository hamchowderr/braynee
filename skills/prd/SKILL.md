---
name: prd
description: >
  Author and manage Product Requirements Documents (PRDs) under
  "2. Areas/Product Manager/PRDs/". Scaffolds new PRDs against the braynee
  schema, audits existing ones, and seeds beads issues from the
  Acceptance Criteria section.
  Use when user says "new PRD", "draft PRD", "create PRD", "write a PRD",
  "PRD for <X>", "audit PRDs", "seed beads from PRD", "convert PRD to issues".
argument-hint: "[new <Name> | audit | seed <Name>]"
allowed-tools: Bash(node:*), Bash(bd:*), Bash(obsidian:*), Read, Write, Edit, AskUserQuestion
---

# PRD Skill

Manages Product Requirements Documents — the contract between vault planning
and code execution. PRDs live at `2. Areas/Product Manager/PRDs/<Name>.md`
and follow a schema that lets braynee seed beads issues from the
Acceptance Criteria section.

## Commands

```bash
# Scaffold a new PRD with the canonical schema
node {baseDir}/scripts/prd-new.mjs "<Name>"

# Same, but as a multi-file folder PRD (hub + section files)
node {baseDir}/scripts/prd-new.mjs "<Name>" --folder-form

# Convert an existing monolithic PRD into the folder form
node {pluginRoot}/scripts/prd-split.mjs "<Name>" [--sections "A,B"] [--all] [--dry-run]

# Audit every PRD against the schema (re-runnable; reports gaps)
node {pluginRoot}/scripts/prd-audit.mjs

# Seed beads issues from a PRD's Acceptance Criteria section
node {pluginRoot}/scripts/prd-seed.mjs "<Name>" [--dry-run]
```

## Two shapes: single-file and folder PRDs

A PRD is either one file or a folder of files. Both are first-class — `audit`
and `seed` treat a folder PRD as ONE document, not as many.

```
monolithic:  PRDs/<Name>.md
folder:      PRDs/<Name>/<Name>.md      <- the hub: frontmatter lives here
             PRDs/<Name>/Architecture.md   <- section files (no frontmatter)
             PRDs/<Name>/Scope.md
```

**Rules that make the folder form work:**

- **The hub is named after its folder** (`Foo/Foo.md`), and is the ONLY file in
  the folder with `type: prd` frontmatter. That is how the hub is identified;
  a second `type: prd` file in the same folder makes it ambiguous.
- **Section files carry no PRD frontmatter.** They are chapters, not PRDs, and
  are never audited or seeded on their own.
- **Acceptance Criteria may live in the hub or in a section file** — `prd-seed`
  and `prd-audit` both read across the hub and all its sections. Keeping them in
  the hub is still preferred, since the hub then reads as a complete summary.
- **Reach for the folder form** when a PRD outgrows one screen of scrolling, or
  when a section (architecture, competitive research, an API reference) is
  substantial enough that people will link to it directly.

`prd-split` never rewrites prose: it moves whole `##` sections into files, leaves
a wikilink in the hub where each one was, and aborts before writing if any line
of the original would be unaccounted for. Use `--dry-run` to see the plan first.

## PRD Schema

### Frontmatter (required fields)

```yaml
---
type: prd
name: <Name> PRD
project: "[[1. Projects/<Name>]]"      # backlink to project file
folder: <slug>                         # project repo dir name — the join key (see note below)
version: "1.0"
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: draft | active | shipped | archived
build_status: not-started | planning | drafting | in-progress | blocked | shipped
client: <optional>                     # only when category=client
seeded: false                          # flips to true after prd-seed runs
seeded_at: ""                          # ISO timestamp set by seeder
seeded_count: 0                        # how many bd issues were created
tags: [prd, ...]
---
```

### Body section order (canonical)

1. Hero / Tagline
2. **MVP Definition** ← Auth, Freemium, 3–5 Core Features (forcing function)
3. Triple-Purpose Asset
4. North Star Metric (with Activation Moment + OKRs table)
5. Lean Canvas
6. Personas / JTBD
7. User Journeys
8. Scope (In / Out / Future)
9. Architecture
10. Milestones
11. **Acceptance Criteria** ← seed source
12. Risks & Open Questions
13. Appendix / Links

### MVP Definition — the gate

A PRD without this section is not ready to seed. Forces three decisions:

```markdown
## MVP Definition

### Auth
<approach: Clerk / Supabase / custom; SSO needs; org/team support>

### Freemium
<free tier limits, paid tier pricing, usage gates, signup-to-paywall path>

### Core Features (3–5)
1. <feature>
2. <feature>
3. <feature>
```

Acceptance Criteria should map back to the Core Features. If a criterion isn't
in service of one of the 3–5 listed features, ask whether the feature list is
incomplete or the criterion is out of scope.

### Acceptance Criteria format (seed contract)

```markdown
## Acceptance Criteria

### Milestone: MVP
- [ ] **[P0] Core scoring engine** — deterministic 7-factor model returns score in <500ms
- [ ] **[P0] WordPress shortcode** — embeds the form via `[dealreveal]`
- [ ] **[P1] Stripe checkout for paid PDF** — webhook on success
- [ ] **[P2] HubSpot CRM sync** — create contact + deal on submit

### Milestone: v1.1
- [ ] **[P1] Admin dashboard** — list submissions with score + status
```

**Parse rules** (deterministic — followed verbatim by `prd-seed`):
- `- [ ] **[Pn] <title>** — <body>` → one `bd create`
- `[Pn]` → priority (P0=critical, P1=high, P2=medium, P3=low)
- Title before em-dash → bd title
- Body after em-dash → bd description
- `### Milestone: <name>` → bd label `milestone:<name>`
- Lines without the `- [ ] **[Pn]**` shape are ignored

## The `new` interview — clarify BEFORE scaffolding

`/braynee:prd new <Name>` must run a short structured interview **before any file is
written**, so the PRD is scoped by the user's answers instead of left full of
template placeholders. Use Claude Code's native **AskUserQuestion** for the discrete
decisions; ask conversationally for the open-ended ones.

**First, read the brief.** Whatever the user already stated (in the prompt, the
linked `1. Projects/<Name>.md`, or recent session) is already answered — do NOT
re-ask it. Interview only the gaps. The flow is re-runnable: on a later pass, skip
anything already filled in the PRD.

**Lock the MVP gate (AskUserQuestion — discrete choices):**
- **Auth** — Clerk · Supabase Auth · custom/JWT · none *(+ note SSO / org-team needs)*
- **Monetization** — free-only · freemium · paid-only · usage-based *(+ free-tier limits & paywall trigger)*
- **Stack / deploy target** — informs Architecture and the eventual `deploy_target`

**Then capture conversationally (no clean fixed options):**
- **Core Features (3–5)** — the forcing function; push back if it's >5 or vague.
- **North Star metric** + the activation moment.
- **Primary persona** + the job they're hiring the product for.
- **Out-of-scope for V1** — at least two explicit non-goals.

**After the interview:**
1. `node {baseDir}/scripts/prd-new.mjs "<Name>"` scaffolds the schema.
2. **Fill the scaffold from the answers** with Edit — replace every placeholder in
   **MVP Definition** (Auth / Freemium / Core Features) and derive **Acceptance
   Criteria** (one `- [ ] **[Pn] title** — body` per core feature, milestone-grouped).
   No `<…>`, `...`, or `…` placeholder may remain in those two sections.
3. **Genuinely-undecided** items go under **Risks & Open Questions** as
   `- **Open question:** <the unresolved decision>` — never invent an answer just to
   clear a placeholder. (The `prd-seed-gate` hook warns if open questions or unfilled
   MVP placeholders remain at seed time.)

## Workflow

1. **Brainstorm in vault** → free-form notes in `1. Projects/<Name>.md`
2. **Interview + draft** → run the `new` interview above, then `node prd-new.mjs <Name>` scaffolds and you fill MVP Definition + Acceptance Criteria from the answers (no placeholders left)
3. **Audit** → `node prd-audit.mjs` confirms schema is clean
4. **Seed** → `node prd-seed.mjs <Name>` creates bd issues, flips `seeded: true`
5. **Build** → in the project repo (`<projects-root>/<slug>/`), `bd ready` shows the seeded backlog

## The `folder:` join key

`folder:` is the **name of the project repo directory**, not a path. It joins
the PRD to its code repo. The repo is looked up inside the configured
**projects root**, resolved in this order:

1. `BRAYNEE_PROJECTS_DIR` — set this if your repos are not under `~/code`
2. `BEADS_CODE_DIR` — legacy override, still honored
3. `~/code` — default only when neither is set (back-compat)

So a PRD with `folder: my-app` joins to `$BRAYNEE_PROJECTS_DIR/my-app` (or
`~/code/my-app` by default). Braynee never assumes `~/code` exists — set
`BRAYNEE_PROJECTS_DIR` once and `prd-audit`, `prd-seed`, and the beads
dashboard all resolve repos from there.
