# PRD Authoring

A PRD is the contract between vault planning and code execution. Brainy
treats it as the seed source for beads issues — the better the PRD, the
better the backlog.

The full schema lives in [`skills/prd/SKILL.md`](../skills/prd/SKILL.md).
This doc covers the *why* and the patterns.

## Lifecycle

1. **Brainstorm** in `1. Projects/<Name>.md` — free-form notes
2. **Draft PRD** at `2. Areas/Product Manager/PRDs/<Name>.md` — `node prd-new.mjs <Name>` scaffolds it
3. **Audit** — `node prd-audit.mjs` confirms schema is clean
4. **Seed** — `node prd-seed.mjs <Name>` creates one bd issue per acceptance criterion
5. **Build** — work on the bd backlog in the project repo (`<projects-root>/<slug>/`)
6. **Evolve** — once MVP ships, ongoing planning moves to `2. Areas/Product Manager/Roadmaps/`. The PRD becomes a historical snapshot.

## The MVP Definition gate

Every PRD needs an `## MVP Definition` section locking three things before any acceptance criteria are written:

- **Auth** — which provider, SSO needs, org/team scope
- **Freemium** — free tier limits, paid pricing, where the paywall lives
- **Core Features (3–5)** — the *minimum* set that defines success

If you can't fill these in, you don't know enough yet to define a product. Stop and figure them out before writing AC. Acceptance Criteria should map back to the Core Features — if a criterion isn't in service of one of the 3–5 listed features, the feature list is incomplete or the criterion is out of scope.

## The folder field is the join key

The PRD's `folder:` value MUST equal the **project repo directory name**.
Brainy joins vault PRDs to code repos on this field — get it wrong and
nothing wires up.

The repo is resolved inside the configured **projects root**:

1. `BRAINY_PROJECTS_DIR` — set this if your repos are not under `~/code`
2. `BEADS_CODE_DIR` — legacy override, still honored
3. `~/code` — default only when neither is set (back-compat)

`folder:` is a directory **name**, never a path, and never assumed to live
under `~/code`. Set `BRAINY_PROJECTS_DIR` once and `prd-audit`, `prd-seed`,
and the beads dashboard all resolve repos from there.

## Acceptance Criteria — write them right

```markdown
## Acceptance Criteria

### Milestone: MVP

- [ ] **[P0] Core scoring engine** — deterministic 7-factor model returns score in <500ms
- [ ] **[P1] Stripe checkout** — webhook on success
```

Patterns that work:
- **One observable outcome per line.** "User can do X" or "System returns Y." Not "Build the dashboard" — that's not testable.
- **Body after the em-dash is the spec.** Treat it as the thing you'll implement, not the thing you'll explain to a stakeholder.
- **Group by milestone.** `### Milestone: MVP` keeps phases distinct, and brainy attaches `milestone:<name>` labels to seeded beads.
- **Priority guides triage, not order.** P0 = blocks the milestone. P1 = required for the milestone. P2/P3 = nice-to-have.

Anti-patterns:
- One mega-criterion that says "build the auth system." Break it apart.
- Vague verbs: "support," "handle," "improve." Replace with observable outcomes.
- Implementation details creep ("uses bcrypt"). Save those for design notes.

## When the PRD evolves

Don't update a shipped PRD. Treat it as a snapshot of the V1 design.
Subsequent planning lives in `Roadmaps/` or in a new `<Name>-V2.md` PRD.

This keeps the audit trail clean and gives `seeded_at` a stable meaning.
