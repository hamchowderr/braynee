---
name: excalidraw
description: >
  Create Excalidraw diagram JSON files that make visual arguments. Use when the user
  wants to visualize workflows, architectures, processes, data models, or any concept
  that benefits from a diagram. Produces .excalidraw files that open in Excalidraw or
  render natively in Obsidian. Trigger when the user asks to "diagram this", "draw a
  flowchart", "create an architecture diagram", "visualize this", "make a diagram",
  or any variation of wanting a visual representation of a concept or system.
---

# Excalidraw Diagram Creator

Generate `.excalidraw` JSON files that **argue visually**, not just display information.

**Setup:** First-time renderer setup instructions are at the bottom of this file.

**Before generating any diagram**, read `references/color-palette.md` — it is the
single source of truth for all color choices.

---

## Core Philosophy

**Diagrams should ARGUE, not DISPLAY.**

A diagram isn't formatted text. It's a visual argument that shows relationships,
causality, and flow that words alone can't express. The shape should BE the meaning.

**The Isomorphism Test**: If you removed all text, would the structure alone communicate
the concept? If not, redesign.

**The Education Test**: Could someone learn something concrete from this diagram, or
does it just label boxes? A good diagram teaches.

---

## Depth Assessment (Do This First)

### Simple/Conceptual Diagrams
Use abstract shapes when explaining a mental model, philosophy, or concept where the
audience doesn't need technical specifics.

### Comprehensive/Technical Diagrams
Use concrete examples when diagramming a real system, protocol, or architecture that
will be used to teach or explain. **You MUST include evidence artifacts** (actual data
formats, real function names, API endpoint names) for technical diagrams.

**For technical diagrams, research the actual specifications before drawing anything.**

---

## Design Process

### Step 1: Understand Deeply
Read the content. For each concept, ask:
- What does this concept **DO**?
- What relationships exist between concepts?
- What's the core transformation or flow?
- What would someone need to SEE to understand this?

### Step 2: Map Concepts to Patterns

| If the concept... | Use this pattern |
|-------------------|------------------|
| Spawns multiple outputs | **Fan-out** (radial arrows from center) |
| Combines inputs into one | **Convergence** (funnel) |
| Has hierarchy/nesting | **Tree** (lines + free-floating text) |
| Is a sequence of steps | **Timeline** (line + dots + labels) |
| Loops or improves | **Spiral/Cycle** (arrow returning to start) |
| Is an abstract state | **Cloud** (overlapping ellipses) |
| Transforms input to output | **Assembly line** (before → process → after) |
| Compares two things | **Side-by-side** (parallel with contrast) |
| Separates into phases | **Gap/Break** (visual whitespace between sections) |

### Step 3: Ensure Variety
Each major concept must use a different visual pattern. No uniform card grids.

### Step 4: Sketch the Flow
Before JSON, trace how the eye moves through the diagram. There should be a clear story.

### Step 5: Generate JSON
See reference files. Build section by section for large diagrams.

### Step 6: Render & Validate (MANDATORY)
Render to PNG and inspect. Fix. Repeat.

---

## Container vs. Free-Floating Text

Default to free-floating text. Add containers only when they serve a purpose.

| Use a Container When... | Use Free-Floating Text When... |
|------------------------|-------------------------------|
| It's the focal point of a section | It's a label or description |
| Arrows need to connect to it | It's supporting detail |
| The shape itself carries meaning | It describes something nearby |
| It represents a distinct "thing" | It's a section title or annotation |

**Aim for <30% of text elements inside containers.**

---

## Large Diagram Strategy

**Build JSON one section at a time.** Never generate the entire file in a single pass.

1. Create the base file with the wrapper + first section
2. Add one section per edit — take time with layout and spacing
3. Use descriptive string IDs (`"trigger_rect"`, `"auth_arrow"`)
4. Namespace seeds by section (section 1 → 100xxx, section 2 → 200xxx)
5. Update cross-section bindings as you go
6. After all sections, review the full JSON for broken bindings
7. Then render and validate

---

## Shape Meaning

| Concept Type | Shape |
|--------------|-------|
| Labels, descriptions | **none** (free-floating text) |
| Timeline markers, bullet points | small `ellipse` (10–20px) |
| Start, trigger, input | `ellipse` |
| End, output, result | `ellipse` |
| Decision, condition | `diamond` |
| Process, action, step | `rectangle` |
| Abstract state, context | overlapping `ellipse` |
| Hierarchy | lines + text (no boxes) |

---

## Modern Aesthetics

- `roughness: 0` — always. Clean, crisp edges.
- `strokeWidth: 2` — standard. Use 1 for dividers, 3 for key connections.
- `opacity: 100` — always. No transparency.
- `fontFamily: 3` — always.

---

## Layout Principles

| Role | Width × Height |
|------|----------------|
| Hero | 300 × 150 |
| Primary | 180 × 90 |
| Secondary | 120 × 60 |
| Small | 60 × 40 |

- Most important element has the most whitespace around it (200px+)
- Siblings: 60–80px apart. Major sections: 150–200px apart.
- If A relates to B, there must be an arrow.

---

## JSON Structure

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

See `references/element-templates.md` for copy-paste element JSON.
See `references/color-palette.md` for all color values.
See `references/json-schema.md` for full property reference.

---

## Render & Validate (MANDATORY)

You cannot judge a diagram from JSON alone. After generating or editing, render to PNG,
view it, and fix what you see — in a loop until it's right.

**Render:**
```bash
cd plugins/excalidraw/skills/excalidraw/references
uv run python render_excalidraw.py <path-to-file.excalidraw>
```

Then use the **Read tool** on the PNG.

**The loop:**
1. Render → Read PNG
2. Audit against your original design intent
3. Check: text overflow, broken arrows, overlapping elements, lopsided composition
4. Fix coordinates, widen containers, reroute arrows
5. Re-render → repeat until clean (typically 2–4 iterations)

**Stop when:**
- Rendered diagram matches your design intent
- No text clipped, overlapping, or unreadable
- Arrows route cleanly to the right elements
- Spacing is consistent
- You'd show this to someone without caveats

**First-time setup:**
```bash
cd plugins/excalidraw/skills/excalidraw/references
uv sync
uv run playwright install chromium
```

---

## Quality Checklist

- [ ] Read `references/color-palette.md` before generating
- [ ] Each major concept uses a different visual pattern
- [ ] <30% of text elements inside containers
- [ ] `roughness: 0`, `opacity: 100`, `fontFamily: 3` on all elements
- [ ] Built section by section (not one giant pass)
- [ ] Rendered to PNG and visually inspected
- [ ] No text overflow, overlapping, or broken arrows
- [ ] For technical diagrams: real names, real data shapes, evidence artifacts
