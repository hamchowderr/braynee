# ExcalidrawAutomate API Reference

This file is referenced from `~/.claude/CLAUDE.md`. Read this before writing any EA scripts.

## ExcalidrawAutomate API reference (LOCAL)

| Doc | Path (`~/.claude/reference/obsidian-excalidraw-plugin/`) |
|:----|:-----|
| LLM training data | `docs/AITrainingData/ExcalidrawAutomate full library for LLM training.md` |
| Type definitions | `docs/AITrainingData/Excalidraw Automate library and related type definitions.md` |
| Script library (100+) | `docs/AITrainingData/Excalidraw Script Library.md` |
| Advanced patterns | `docs/AITrainingData/ExcalidrawStartupExample.md` |
| API intro | `docs/API/introduction.md` |
| Element styling | `docs/API/element_style.md` |
| Objects & methods | `docs/API/objects.md` |
| Utility functions | `docs/API/utility.md` |
| Complete API map | `docs/API/attributes_functions_overview.md` |
| TypeScript defs | `docs/API/ExcalidrawAutomate.d.ts` |
| 96 example scripts | `ea-scripts/` |

## Key example scripts to study

- `ea-scripts/Mindmap Builder.md` — Complex diagram generation with sidepanel UI
- `ea-scripts/Connect elements.md` — Smart group detection & connections
- `ea-scripts/Auto Layout.md` — ELK.js automatic layout
- `ea-scripts/Full-Year Calendar Generator.md` — Grid-based generation pattern

## Script pattern for state machines

```javascript
// 3. Resources/Excalidraw/scripts/generate-<project>-<component>-statediagram.md
const ea = ExcalidrawAutomate;
ea.reset();
ea.style.strokeColor = "#1e1e1e";
ea.style.roughness = 0;
ea.style.roundness = { type: 3 };

// Define states as rectangles with text
const states = [
  { name: "Idle", x: 0, y: 0 },
  { name: "Loading", x: 300, y: 0 },
  { name: "Error", x: 300, y: 200 },
  { name: "Success", x: 600, y: 0 },
];

const ids = {};
for (const s of states) {
  ids[s.name] = ea.addText(s.x + 10, s.y + 10, s.name, {
    box: true,
    boxPadding: 15,
    width: 150,
    textAlign: "center",
  });
}

// Connect states with labeled arrows
ea.connectObjects(ids["Idle"], "right", ids["Loading"], "left", {
  startArrowHead: null, endArrowHead: "arrow",
  label: "submit()",
});
// ... more connections

await ea.create({
  filename: "Minions-auth-flow",
  foldername: "3. Resources/Excalidraw",
  onNewPane: true,
});
```

## Key EA API methods

| Method | Purpose |
|:-------|:--------|
| `ea.reset()` | **Always call first** — initialize state |
| `ea.addText(x, y, text, {box, boxPadding, width, textAlign, textVerticalAlign, boxStrokeColor})` | Text with optional container |
| `ea.addRect(x, y, w, h)` | Rectangles |
| `ea.addEllipse(x, y, w, h)` | Ellipses (start/end nodes) |
| `ea.addDiamond(x, y, w, h)` | Decision diamonds |
| `ea.addBlob(x, y, w, h)` | Organic shapes |
| `ea.addArrow([[x1,y1],[x2,y2]], {startArrowHead, endArrowHead})` | Arrows |
| `ea.addLine([[x1,y1],[x2,y2]])` | Lines (no arrows) |
| `ea.connectObjects(idA, sideA, idB, sideB, {label, startArrowHead, endArrowHead, numberOfPoints, padding})` | Connect shapes (sides: `"top"\|"bottom"\|"left"\|"right"`) |
| `ea.addToGroup([ids])` | Group elements, returns group ID |
| `ea.getMaximumGroups(elements)` | Find logical element groups |
| `ea.getLargestElement(elements)` | Largest by area |
| `await ea.create({filename, foldername, onNewPane})` | Save the drawing |

**`box` parameter accepts:** `true` (default rect), `"box"`, `"blob"`, `"ellipse"`, `"diamond"`

## Style properties

```javascript
ea.style.strokeColor = "#1e1e1e";     // CSS color
ea.style.backgroundColor = "#e8f4f8"; // Fill color or "transparent"
ea.style.fillStyle = "solid";         // "hachure" | "cross-hatch" | "solid"
ea.style.strokeWidth = 2;             // Pixel width
ea.style.strokeStyle = "solid";       // "solid" | "dashed" | "dotted"
ea.style.roughness = 0;               // 0=Architect, 1=Artist, 2=Cartoonist
ea.style.roundness = { type: 3 };     // Rounded corners
ea.style.fontFamily = 1;              // 1=Virgil, 2=Helvetica, 3=Cascadia
ea.style.fontSize = 20;               // Font size
ea.style.opacity = 100;               // 0-100
```

## Advanced utilities

- `ea.getExcalidrawAPI()` — Access native Excalidraw API
- `ea.wrapText(text, lineLen)` — Text wrapping
- `ea.verifyMinimumPluginVersion("x.y.z")` — Version check
- `ea.getScriptSettings()` / `ea.setScriptSettings(settings)` — Persistent config
- `ea.obsidian` — Full Obsidian API access
- `utils.inputPrompt(header, placeholder, value)` — Modal input dialog
- `utils.suggester(items, values)` — Item picker dialog
