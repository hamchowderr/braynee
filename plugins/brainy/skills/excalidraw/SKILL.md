---
name: excalidraw
description: >
  Create Excalidraw diagrams in Obsidian using the ExcalidrawAutomate (EA) API.
  Generates .excalidraw files saved directly to the vault — no external tools needed,
  Obsidian renders them natively. Two modes: (1) Single diagram on demand for any
  workflow, architecture, process, or data model — trigger on "diagram this", "draw
  a flowchart", "create an architecture diagram", "visualize this", "make an Excalidraw".
  (2) Full codebase walkthrough — autonomously reads a codebase and produces a
  complete visual system documentation (architecture, data flow, sequence, ER) plus
  interlinked Markdown notes — trigger on "document this codebase", "walk through this
  system", "diagram this app", "map out this repo", "create documentation for this project".
---

# Excalidraw Diagram Creator

Generate Excalidraw diagrams using the ExcalidrawAutomate (EA) API. Output is a
`.excalidraw` file saved directly to the Obsidian vault — Obsidian renders it natively.

**Before writing any diagram code**, read the bundled EA API reference at:
`${CLAUDE_PLUGIN_ROOT}/skills/excalidraw/reference/excalidraw-api.md`

For the full upstream plugin source, clone https://github.com/zsviczian/obsidian-excalidraw-plugin.

This skill has **two modes** depending on the request:

- **Single Diagram Mode** — user wants ONE diagram of a specific concept. Output: one `.excalidraw` file.
- **Codebase Walkthrough Mode** — user wants to document an entire codebase visually. Output: 4-6 `.excalidraw` files + interlinked markdown notes.

If the request mentions "document the codebase", "walk through this system", "map out this repo", or similar, jump to the **Codebase Walkthrough Mode** section. Otherwise stay in Single Diagram Mode.

---

## Core Philosophy

**Diagrams should ARGUE, not DISPLAY.**

A diagram isn't formatted text. It's a visual argument that shows relationships,
causality, and flow that words alone can't express. The shape should BE the meaning.

**The Isomorphism Test**: If you removed all text, would the structure alone communicate
the concept? If not, redesign.

For technical diagrams, use real names from the codebase — never "Service A" or "Handler".

---

## How to Generate a Diagram

Every diagram is a JavaScript script that uses the EA API. The script runs via
Obsidian's Templater plugin, or can be saved as an EA script in the vault's scripts folder.

### Script Pattern

```javascript
const ea = ExcalidrawAutomate;
ea.reset(); // Always call first

// Set global styles
ea.style.roughness = 0;
ea.style.strokeWidth = 2;
ea.style.fontFamily = 1; // 1=Virgil, 2=Helvetica, 3=Cascadia

// Add elements
const rectId = ea.addRect(x, y, width, height);
const textId = ea.addText(x, y, "Label", { box: true, boxPadding: 15, width: 200 });
const ellipseId = ea.addEllipse(x, y, width, height);
const diamondId = ea.addDiamond(x, y, width, height);

// Connect elements
ea.connectObjects(idA, "right", idB, "left", {
  label: "arrow label",
  startArrowHead: null,
  endArrowHead: "arrow",
});

// Save to vault
await ea.create({
  filename: "diagram-name",
  foldername: "2. Areas/Excalidraw",
  onNewPane: true,
});
```

### Key EA Methods

| Method | Purpose |
|--------|---------|
| `ea.reset()` | **Always call first** |
| `ea.addText(x, y, text, opts)` | Text with optional container (`box: true`) |
| `ea.addRect(x, y, w, h)` | Rectangle |
| `ea.addEllipse(x, y, w, h)` | Ellipse (start/end nodes) |
| `ea.addDiamond(x, y, w, h)` | Decision diamond |
| `ea.addLine([[x1,y1],[x2,y2]])` | Line (no arrow) |
| `ea.addArrow([[x1,y1],[x2,y2]])` | Arrow |
| `ea.connectObjects(idA, sideA, idB, sideB, opts)` | Smart connection between shapes |
| `ea.addToGroup([ids])` | Group elements |
| `await ea.create({filename, foldername, onNewPane})` | Save to vault |

Sides for `connectObjects`: `"top"` `"bottom"` `"left"` `"right"`

The `box` parameter on `addText` accepts: `true` (rect), `"box"`, `"blob"`, `"ellipse"`, `"diamond"`

### Style Properties

```javascript
ea.style.strokeColor = "#1e1e1e";
ea.style.backgroundColor = "#e8f4f8";
ea.style.fillStyle = "solid";        // "hachure" | "cross-hatch" | "solid"
ea.style.strokeWidth = 2;
ea.style.strokeStyle = "solid";      // "solid" | "dashed" | "dotted"
ea.style.roughness = 0;              // 0=clean, 1=artist, 2=cartoonist
ea.style.roundness = { type: 3 };   // Rounded corners
ea.style.fontFamily = 1;            // 1=Virgil, 2=Helvetica, 3=Cascadia
ea.style.fontSize = 20;
ea.style.opacity = 100;
```

Change styles between element additions — each new element picks up the current style.

---

## Color Palette

See `references/color-palette.md` for the semantic color system. Quick reference:

| Semantic Purpose | backgroundColor | strokeColor |
|------------------|----------------|-------------|
| Primary/Neutral | `#3b82f6` | `#1e3a5f` |
| Start/Trigger/User | `#fed7aa` | `#c2410c` |
| End/Success | `#a7f3d0` | `#047857` |
| Decision | `#fef3c7` | `#b45309` |
| Auth/AI/Special | `#ddd6fe` | `#6d28d9` |
| Error/Warning | `#fecaca` | `#b91c1c` |

---

## Single Diagram Mode

### Design Process

**Step 1: Understand the concept** — What does this visualize? What's the core flow or argument? Simple/conceptual (abstract shapes) or technical (real names, real data)?

**Step 2: Map concepts to visual patterns**

| If the concept... | Use this pattern |
|-------------------|------------------|
| Spawns multiple outputs | Fan-out (radial arrows from center) |
| Combines inputs | Convergence (funnel) |
| Has hierarchy | Tree (lines + text, no boxes needed) |
| Is a sequence | Timeline (line + dots + labels) |
| Loops | Cycle (arrow returning to start) |
| Transforms input | Assembly line (before → process → after) |
| Has phases | Gap/break (visual whitespace between sections) |

**Step 3: Plan layout before writing code** — Sketch x/y coordinates. Typical spacing: sibling elements 60–80px apart, major sections 150–200px apart, ~100px padding around the full diagram.

**Step 4: Write the script** — Use `ea.connectObjects()` over manual `ea.addArrow()` when connecting named shapes — it handles positioning automatically.

**Step 5: Save and review** — `await ea.create()` saves to the vault. Open the file in Obsidian to review. Adjust coordinates and re-run if layout needs fixing.

### Default Output Location

`2. Areas/Excalidraw/` — or `2. Areas/Excalidraw/<project-name>/` for project-specific diagrams.

### Single Diagram Quality Checklist

- [ ] `ea.reset()` called first
- [ ] Styles set before elements that use them
- [ ] `connectObjects()` used for named element connections
- [ ] Each major concept uses a different visual pattern
- [ ] Real names used for technical diagrams (not "Service A")
- [ ] Saved to `2. Areas/Excalidraw/` or appropriate subfolder
- [ ] Reviewed in Obsidian after saving

---

## Codebase Walkthrough Mode

You are a senior architect handed a codebase you've never seen. Your job: read through it systematically and produce a **visual walkthrough** — Excalidraw diagrams embedded in Obsidian-compatible Markdown. Someone should understand the entire application from your diagrams without reading a single line of source code.

### Output Structure

```
3. Resources/<project-name>/
  index.md                  → ![[project-architecture.excalidraw]]
  architecture.md           → ![[project-architecture.excalidraw]]
  data-model.md             → ![[project-data-model.excalidraw]]
  flows/
    overview.md             → ![[project-flows-overview.excalidraw]]
    [flow-name].md          → ![[project-flows-[name].excalidraw]]
  integrations.md           → ![[project-integrations.excalidraw]]
  glossary.md

2. Areas/Excalidraw/<project-name>/
  project-architecture.excalidraw
  project-data-model.excalidraw
  project-flows-overview.excalidraw
  project-flows-[name].excalidraw
  project-integrations.excalidraw
```

Each markdown file embeds its diagram with `![[diagram-name.excalidraw]]`.

### Diagrams to Produce

**1. Architecture** (`project-architecture.excalidraw`) — All major components, external services, databases, auth system. Arrows show data flow direction. Group related components with boundary rectangles. Use actual service names.

**2. Data Model** (`project-data-model.excalidraw`) — Tables as rectangles with real column names listed. Lines connecting related tables with cardinality labels. Matches the actual schema from the code.

**3. Request Flow Overview** (`project-flows-overview.excalidraw`) — How a request enters, hits middleware/auth, routes to a handler, touches the DB, returns a response. The spine of the application.

**4. Key User Flow Sequences** (`project-flows-[name].excalidraw`) — Swimlane/sequence diagrams for the 3–5 most important user flows: auth (login/signup/token refresh), primary feature (the core thing the app does), any complex async/background flows. Use actual function names, route paths, and data shapes.

**5. Integrations** (`project-integrations.excalidraw`) — All external services — what the app sends, what it receives. Real API endpoint names and payload shapes where discoverable from the code.

### Shape Conventions

| What | Method | Color |
|------|--------|-------|
| User / external system | `addEllipse` | Start/Trigger (`#fed7aa` / `#c2410c`) |
| Application component | `addText(..., {box:true})` | Primary (`#3b82f6` / `#1e3a5f`) |
| Database | `addText(..., {box:true})` | Secondary (`#60a5fa` / `#1e3a5f`) |
| Auth / middleware | `addText(..., {box:true})` | AI/Special (`#ddd6fe` / `#6d28d9`) |
| External API | `addText(..., {box:true})` | Tertiary (`#93c5fd` / `#1e3a5f`) |
| Decision / branch | `addDiamond` | Decision (`#fef3c7` / `#b45309`) |

### Phase 1: Survey

1. Read root directory, `package.json` / `go.mod` / `pyproject.toml`, `README.md`, `.env.example`, `docker-compose.yml`.
2. Identify: language + framework, entry points, database + ORM, auth approach, external services, deployment target.

Share a brief summary with the user before proceeding.

### Phase 2: Deep Read

Read the codebase looking for things that become diagrams.

1. **Entry points + routing** → architecture + request flow diagrams
2. **Data layer** → ER diagram (actual column names)
3. **Core user flows** → sequence diagrams (3–5 flows)
4. **External integrations** → integrations diagram
5. **Auth + middleware** → part of flow diagrams

Track actual file names, function names, route paths — these go in diagrams verbatim.

Tell the user which flows you plan to diagram before producing output.

### Phase 3: Produce

Generate each diagram script, run it (or provide it for the user to run via Templater), then write the markdown files. Each markdown file opens with its diagram embed.

**index.md** — landing page with one-paragraph summary, tech stack table, `![[project-architecture.excalidraw]]` embed, and wikilinks to all other files.

**Every other file:**
- Opens with `![[diagram.excalidraw]]`
- Concise explanatory text below (key decisions, what to notice)
- Wikilinks to related files
- `> [!note]` callouts for important context
- "Related" section at the bottom

### Execution Notes

- After Phase 1, share findings. After Phase 2, share planned flows.
- If running low on context, finish architecture + data-model first — those two give 80%.
- Large codebases: focus on critical paths, note what you skimmed.
- Monorepos: top-level architecture showing how packages relate, then drill in.

### Codebase Walkthrough Quality Checklist

- [ ] `ea.reset()` called at start of every diagram script
- [ ] Real names throughout — no generic placeholders
- [ ] Architecture: all major components, data flow direction, external services
- [ ] Data model: actual column names + real relationships
- [ ] At least 2 flow diagrams for key user paths
- [ ] All diagrams saved to `2. Areas/Excalidraw/<project-name>/`
- [ ] All markdown files embed diagrams with `![[filename.excalidraw]]`
- [ ] index.md stands alone and links to everything else
