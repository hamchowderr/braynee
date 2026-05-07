---
name: prd
description: >
  Author and manage Product Requirements Documents (PRDs) under
  "2. Areas/Product Manager/PRDs/". Scaffolds new PRDs against the brainy
  schema, audits existing ones, and seeds beads issues from the
  Acceptance Criteria section.
  Use when user says "new PRD", "draft PRD", "create PRD", "write a PRD",
  "PRD for <X>", "audit PRDs", "seed beads from PRD", "convert PRD to issues".
argument-hint: [new <Name> | audit | seed <Name>]
allowed-tools: Bash(node:*), Bash(bd:*), Bash(obsidian:*), Read, Write, Edit
---

# PRD Skill

Manages Product Requirements Documents — the contract between vault planning
and code execution. PRDs live at `2. Areas/Product Manager/PRDs/<Name>.md`
and follow a schema that lets brainy seed beads issues from the
Acceptance Criteria section.

## Commands

```bash
# Scaffold a new PRD with the canonical schema
node {baseDir}/scripts/prd-new.mjs "<Name>"

# Audit every PRD against the schema (re-runnable; reports gaps)
node {pluginRoot}/scripts/prd-audit.mjs

# Seed beads issues from a PRD's Acceptance Criteria section
node {pluginRoot}/scripts/prd-seed.mjs "<Name>" [--dry-run]
```

## PRD Schema

### Frontmatter (required fields)

```yaml
---
type: prd
name: <Name> PRD
project: "[[1. Projects/<Name>]]"      # backlink to project file
folder: <slug>                         # MUST match ~/code/<slug>/ — the join key
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
2. Triple-Purpose Asset
3. North Star Metric (with Activation Moment + OKRs table)
4. Lean Canvas
5. Personas / JTBD
6. User Journeys
7. Scope (In / Out / Future)
8. Architecture
9. Milestones
10. **Acceptance Criteria** ← seed source
11. Risks & Open Questions
12. Appendix / Links

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

## Workflow

1. **Brainstorm in vault** → free-form notes in `1. Projects/<Name>.md`
2. **Draft PRD** → `node prd-new.mjs <Name>` scaffolds the file → fill in sections
3. **Audit** → `node prd-audit.mjs` confirms schema is clean
4. **Seed** → `node prd-seed.mjs <Name>` creates bd issues, flips `seeded: true`
5. **Build** → in `~/code/<slug>/`, `bd ready` shows the seeded backlog
