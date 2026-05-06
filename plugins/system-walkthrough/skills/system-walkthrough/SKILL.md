---
name: system-walkthrough
description: >
  Autonomously reads through a codebase and produces a complete visual system walkthrough
  as Excalidraw diagrams embedded in Obsidian-compatible Markdown. Generates architecture
  diagrams, data flow charts, sequence diagrams, and ER diagrams as .excalidraw files
  that render natively in Obsidian. Use this skill whenever the user asks to "document
  this codebase", "walk through this system", "diagram this app", "map out this repo",
  "create documentation for this project", or any variation of wanting a visual
  understanding of how a codebase works. Also trigger when the user says things like
  "show me how this app works", "reverse-engineer the architecture", or "what does this
  codebase do". Works on any language, framework, or stack.
---

# System Walkthrough

You are a senior architect handed a codebase you've never seen. Your job: read through
it systematically and produce a **visual walkthrough** — a set of Excalidraw diagrams
embedded in Obsidian-compatible Markdown. Someone should be able to look at your diagrams
and understand the entire application without reading a single line of source code.

**Before generating any diagrams**, read `references/color-palette.md` in this skill
directory. All colors must come from that palette — no improvising.

---

## Core Philosophy

**Diagrams should ARGUE, not DISPLAY.**

A diagram isn't formatted text. It's a visual argument that shows relationships,
causality, and flow that words alone can't express. The shape should BE the meaning.

**The Isomorphism Test**: If you removed all text, would the structure alone communicate
the concept? If not, redesign.

**The Education Test**: Could someone learn something concrete from this diagram, or
does it just label boxes? A good diagram teaches — it shows actual file names, real
function calls, concrete data formats.

---

## Output Format

All diagrams are `.excalidraw` JSON files. Each markdown file embeds its diagram with:

```
![[diagram-name.excalidraw]]
```

Obsidian renders this inline. The `.excalidraw` files go in the vault's
`2. Areas/Excalidraw/` folder (or the nearest Excalidraw folder the vault uses).
The markdown walkthrough files go in `3. Resources/` or wherever the user specifies.

### Output Structure

```
Walkthrough markdown → vault's 3. Resources/<project-name>/
  index.md                  → embeds architecture.excalidraw
  architecture.md           → embeds architecture.excalidraw
  data-model.md             → embeds data-model.excalidraw
  flows/
    overview.md             → embeds flows-overview.excalidraw
    [flow-name].md          → embeds flows-[name].excalidraw
  integrations.md           → embeds integrations.excalidraw
  glossary.md

Excalidraw diagrams → vault's 2. Areas/Excalidraw/<project-name>/
  architecture.excalidraw
  data-model.excalidraw
  flows-overview.excalidraw
  flows-[name].excalidraw
  integrations.excalidraw
```

---

## Diagram Types to Produce

### 1. Architecture Overview (architecture.excalidraw)
Fan-out or layered diagram showing all major components and how they connect.
Every external service, database, auth system, and major module as a node.
Arrows show data flow direction. Use boundary rectangles to cluster related components.

### 2. Entity Relationship / Data Model (data-model.excalidraw)
Tables as rectangles with field names listed. Lines connecting related tables
with cardinality labels (1, N). Show the actual column names from the schema.

### 3. Request Flow Overview (flows-overview.excalidraw)
Flowchart showing how a request enters the system, hits middleware/auth, routes to
a handler, touches the database, and returns a response. The spine of the application.

### 4. Key User Flow Sequences (flows-[name].excalidraw, one per major flow)
Swimlane/sequence diagrams for the 3-5 most important things a user does:
- Auth flow (login/signup/token refresh)
- Primary feature flow (the core thing the app does)
- Any complex background/async flows

Show the actual function names, route paths, and data shapes — not generic placeholders.

### 5. Integrations (integrations.excalidraw)
All external services mapped out — what the app sends, what it receives. Include
actual API endpoint names and payload shapes where discoverable from the code.

---

## Phase 1: Survey

Get the lay of the land before reading code in depth.

1. Read the root directory listing, `package.json`/`Cargo.toml`/`go.mod`/`pyproject.toml`,
   `README.md`, and any `.env.example` or `docker-compose.yml`.
2. Identify:
   - Language and framework
   - Entry point(s)
   - Approximate size (rough file count)
   - Database and ORM
   - Auth approach
   - External services / APIs
   - Deployment target if apparent

After this phase, share a brief summary with the user before proceeding.

---

## Phase 2: Deep Read

Read the codebase systematically. You're looking for things that become diagrams.

**What to map:**

1. **Entry points and routing** — What comes in and where does it go? This becomes
   your architecture overview and request flow diagrams.
2. **Data layer** — Schema, models, relationships. This becomes your ER diagram.
3. **Core user flows** — The 3-5 most important things a user does in the app. Each
   becomes a sequence/flow diagram.
4. **External integrations** — APIs, webhooks, third-party services. These become
   nodes in your architecture diagram.
5. **Auth and middleware** — How requests are intercepted and validated. This goes
   into your flow diagrams.

**What to skip:** Generated files, lock files, tests, node_modules, static assets,
boilerplate that teaches you nothing.

**While reading, track:**
- Actual file names, function names, route paths — these go in the diagrams verbatim
- Real data shapes (what a request body looks like, what a DB row contains)
- The sequence in which things happen for each user flow

After reading, tell the user which flows you plan to diagram before producing output.

---

## Phase 3: Produce the Walkthrough

### Generating .excalidraw Files

Each diagram is a raw `.excalidraw` JSON file. See the reference files in this skill:
- `references/element-templates.md` — copy-paste JSON for rectangles, arrows, text, lines, dots
- `references/color-palette.md` — all colors by semantic purpose
- `references/json-schema.md` — full property reference

**JSON structure:**
```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [...],
  "appState": {
    "viewBackgroundColor": "#ffffff",
    "gridSize": 20
  },
  "files": {}
}
```

**For large diagrams, build section by section.** Each section gets its own edit pass.
Namespace element ID seeds by section (section 1 → 100xxx, section 2 → 200xxx).

### Shape Conventions for Walkthrough Diagrams

| What | Shape | Colors |
|------|-------|--------|
| External system / user | `ellipse` | Start/Trigger |
| Application component / service | `rectangle` | Primary |
| Database | `rectangle` | Secondary |
| Auth/middleware layer | `rectangle` | AI/LLM |
| External API | `rectangle` | Tertiary |
| Decision / condition | `diamond` | Decision |
| Section boundary | `rectangle` | Light fill, no stroke |

### Large Diagram Strategy

Build the JSON one section at a time:
1. Create the base file with the wrapper and first section
2. Add one section per edit pass — take time with layout and spacing
3. Use descriptive string IDs (`"api_handler_rect"`, `"auth_arrow"`)
4. Update cross-section bindings as you go
5. After all sections, review the full JSON for broken bindings
6. Then render and validate

### Render & Validate (MANDATORY)

After generating each `.excalidraw` file, render it to PNG and inspect visually.

**Setup (first time only):**
```bash
cd plugins/system-walkthrough/skills/system-walkthrough/references
uv sync
uv run playwright install chromium
```

**Render:**
```bash
uv run python references/render_excalidraw.py <path-to-file.excalidraw>
```

Then use the Read tool on the output PNG. Fix what you see. Repeat until:
- No text is clipped or overlapping
- Arrows connect to the right elements
- Spacing is balanced
- A new developer could understand the system from the diagram alone

**The loop:**
1. Render → Read PNG → audit against your design intent
2. Check for: text overflow, broken arrows, lopsided composition, unreadable labels
3. Fix coordinates, widen containers, reroute arrows
4. Re-render → repeat until clean

### Writing the Markdown Files

**index.md** — Landing page. Contains:
- One-paragraph summary of the system
- Tech stack table
- `![[architecture.excalidraw]]` embed
- Wikilinks to every other walkthrough file in reading order

**Every other file** should:
- Open with the diagram embed (`![[diagram-name.excalidraw]]`)
- Follow with concise explanatory text — what the diagram shows, key decisions, gotchas
- Use wikilinks (`[[other-file]]`) to cross-reference related files
- Use callouts (`> [!note]`, `> [!warning]`) for important context
- End with a "Related" section

**Wikilink conventions:** `[[architecture]]`, `[[data-model]]`, `[[flows/user-authentication]]`

---

## Execution Notes

- **Progress updates:** After Phase 1, share findings. After Phase 2, share planned flows.
- **Prioritize:** If running low on context, finish architecture + data-model first.
  Those two diagrams give 80% of the understanding.
- **Large codebases:** Focus on critical paths. Note what you skimmed.
- **Monorepos:** Create a top-level architecture diagram showing how packages relate,
  then drill into each significant package.
- **Use real names:** Every node, arrow label, and field name should come from the
  actual codebase — not generic placeholders like "Service A" or "Handler".

---

## Quality Checklist

### Depth & Accuracy
- [ ] Actual schemas, route definitions, and function signatures read from the code
- [ ] Real names used throughout — no generic placeholders
- [ ] Data shapes shown where relevant (what goes in, what comes out)

### Diagrams
- [ ] Architecture: all major components, data flow direction, external services
- [ ] Data model: actual column names, real relationships with cardinality
- [ ] At least 2 flow diagrams for key user paths
- [ ] Rendered to PNG and visually inspected
- [ ] No text overflow, overlapping elements, or broken arrows

### Markdown
- [ ] All diagrams embedded with `![[filename.excalidraw]]`
- [ ] Wikilinks connect related files
- [ ] index.md stands alone and links to everything else
