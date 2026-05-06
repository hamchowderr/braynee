---
name: excalidraw
description: >
  Create Excalidraw diagrams in Obsidian using the ExcalidrawAutomate (EA) API.
  Generates .excalidraw files saved directly to the vault — no external tools needed,
  Obsidian renders them natively. Use when the user wants to visualize workflows,
  architectures, processes, data models, or any concept as a diagram. Trigger when
  the user asks to "diagram this", "draw a flowchart", "create an architecture diagram",
  "visualize this", "make an Excalidraw", or any variation of wanting a visual
  representation saved to their vault.
---

# Excalidraw Diagram Creator

Generate Excalidraw diagrams using the ExcalidrawAutomate (EA) API. Output is a
`.excalidraw` file saved directly to the Obsidian vault — Obsidian renders it natively.

**Before writing any diagram code**, read the bundled EA API reference at:
`${CLAUDE_PLUGIN_ROOT}/skills/excalidraw/reference/excalidraw-api.md`

For the full upstream plugin source, clone https://github.com/zsviczian/obsidian-excalidraw-plugin.

---

## Core Philosophy

**Diagrams should ARGUE, not DISPLAY.**

A diagram isn't formatted text. It's a visual argument that shows relationships,
causality, and flow that words alone can't express. The shape should BE the meaning.

**The Isomorphism Test**: If you removed all text, would the structure alone communicate
the concept? If not, redesign.

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

## Design Process

### Step 1: Understand the concept
- What does this visualize? What's the core flow or argument?
- Simple/conceptual (abstract shapes) or technical (real names, real data)?

### Step 2: Map concepts to visual patterns

| If the concept... | Use this pattern |
|-------------------|------------------|
| Spawns multiple outputs | Fan-out (radial arrows from center) |
| Combines inputs | Convergence (funnel) |
| Has hierarchy | Tree (lines + text, no boxes needed) |
| Is a sequence | Timeline (line + dots + labels) |
| Loops | Cycle (arrow returning to start) |
| Transforms input | Assembly line (before → process → after) |
| Has phases | Gap/break (visual whitespace between sections) |

### Step 3: Plan layout before writing code
Sketch x/y coordinates on paper or in your head. Typical spacing:
- Sibling elements: 60–80px apart
- Major sections: 150–200px apart
- Allow ~100px padding around the full diagram

### Step 4: Write the script
Use `ea.connectObjects()` over manual `ea.addArrow()` when connecting named shapes —
it handles positioning automatically.

### Step 5: Save and review
`await ea.create()` saves to the vault. Open the file in Obsidian to review.
Adjust coordinates and re-run if layout needs fixing.

---

## Output Location

Default save location: `2. Areas/Excalidraw/`

For project-specific diagrams: `2. Areas/Excalidraw/<project-name>/`

---

## Quality Checklist

- [ ] `ea.reset()` called first
- [ ] Styles set before elements that use them
- [ ] `connectObjects()` used for named element connections
- [ ] Each major concept uses a different visual pattern
- [ ] Real names used for technical diagrams (not "Service A")
- [ ] Saved to `2. Areas/Excalidraw/` or appropriate subfolder
- [ ] Reviewed in Obsidian after saving
