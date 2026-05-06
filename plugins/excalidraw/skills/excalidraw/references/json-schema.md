# Excalidraw JSON Schema

## Element Types

| Type | Use For |
|------|---------|
| `rectangle` | Processes, actions, components |
| `ellipse` | Entry/exit points, external systems, users |
| `diamond` | Decisions, conditionals |
| `arrow` | Connections between shapes |
| `text` | Labels (free-floating or inside shapes) |
| `line` | Non-arrow structural lines |

## Common Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Unique identifier |
| `type` | string | Element type |
| `x`, `y` | number | Position in pixels |
| `width`, `height` | number | Size in pixels |
| `strokeColor` | string | Border color (hex) |
| `backgroundColor` | string | Fill color (hex or "transparent") |
| `fillStyle` | string | "solid", "hachure", "cross-hatch" |
| `strokeWidth` | number | 1, 2, or 4 |
| `strokeStyle` | string | "solid", "dashed", "dotted" |
| `roughness` | number | 0 = smooth, 1 = default, 2 = rough — use 0 |
| `opacity` | number | Always 100 |
| `seed` | number | Random seed |

## Text-Specific Properties

| Property | Description |
|----------|-------------|
| `text` | The display text (readable words only) |
| `originalText` | Same as text |
| `fontSize` | Size in pixels (16–20 recommended) |
| `fontFamily` | Always 3 (monospace) |
| `textAlign` | "left", "center", "right" |
| `verticalAlign` | "top", "middle", "bottom" |
| `containerId` | ID of parent shape (null if free-floating) |
| `lineHeight` | Always 1.25 |

## Arrow-Specific Properties

| Property | Description |
|----------|-------------|
| `points` | Array of [x, y] coordinates relative to arrow origin |
| `startBinding` | Connection to start shape |
| `endBinding` | Connection to end shape |
| `startArrowhead` | null, "arrow", "bar", "dot", "triangle" |
| `endArrowhead` | null, "arrow", "bar", "dot", "triangle" |

## Binding Format

```json
{
  "elementId": "shapeId",
  "focus": 0,
  "gap": 2
}
```

## Rectangle Roundness

```json
"roundness": { "type": 3 }
```

## BoundElements Format

Shape referencing its contained text:
```json
"boundElements": [{"id": "textId", "type": "text"}]
```

Shape referencing connected arrows:
```json
"boundElements": [{"id": "arrowId", "type": "arrow"}]
```

## Size Guidelines

| Role | Width × Height |
|------|----------------|
| Hero / primary component | 300 × 150 |
| Standard component | 180 × 90 |
| Small component | 120 × 60 |
| Marker dot | 12 × 12 |
| Section label (text) | 200 × 25 |

## Spacing Guidelines

- Between sibling components: 60–80px
- Between major sections: 150–200px
- Padding around diagram content: 80px
- Arrow gap from element edge: 2px
