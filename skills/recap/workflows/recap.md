# Recap Workflow

Routing logic and output format for `/recap`.

---

## Route Selection

Decide mode from the argument before running anything.

| Signal | Mode |
|---|---|
| "yesterday", "today", "last week", "last N days", "last monday", ISO date | **Temporal** |
| "graph" anywhere in the arg | **Graph** |
| Anything else (nouns, topics, project names) | **Topic** |

When ambiguous (e.g. "Convex last week"), run both Temporal and Topic.

---

## Temporal Mode

Scan JSONL session files by date range.

**Step 1 — List sessions**

```bash
python3 {baseDir}/scripts/recap.py list "EXPR"
```

Supported expressions: `yesterday`, `today`, `last week`, `this week`, `last 3 days`,
`last monday`, `2026-05-01`, `3 days ago`.

**Step 2 — Read the list output**

The script prints sessions sorted newest-first: time, message count, project folder,
and the first user message. Use this to decide which sessions are worth expanding.

**Step 3 — Expand sessions that matter**

```bash
python3 {baseDir}/scripts/recap.py expand SESSION_ID
```

Expand 1–3 sessions. Prefer: highest message count, most recent, or sessions in the
current working directory's project. Read the turn-by-turn content to understand
what was decided and what was left unfinished.

**Step 4 — Synthesize**

Group sessions by date. Identify themes across them. Show the user:

```
Yesterday — 3 sessions

  14:23  second-brain  (12 msgs)  "scaffold.py --check implementation"
  16:45  foreman       (8 msgs)   "Supabase auth migration"
  19:12  second-brain  (5 msgs)   "Docker test fixes"

Themes: Setup script audit mode, Docker test harness. Foreman auth branch in progress.
```

---

## Topic Mode

Search vault notes and sessions by content.

**Step 1 — Keyword search (exact terms)**

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qmd-wrapper.mjs search "QUERY"
```

Use for specific names, error messages, function names, exact phrases.

**Step 2 — Semantic search (conceptual)**

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qmd-wrapper.mjs vsearch "QUERY"
```

Use for concepts, themes, intent. Run both — BM25 catches exact matches semantic
misses; semantic catches paraphrases BM25 misses.

**Step 3 — Synthesize**

Read top 3–5 results from each search. Report what was found:
- Which notes are most relevant
- What decisions or patterns appear
- What the current status is based on the most recent note

---

## Graph Mode

Generate an interactive HTML session map.

```bash
python3 {baseDir}/scripts/recap.py graph "EXPR" --out ~/Downloads/recap-graph.html
```

Tell the user: "Graph saved to `~/Downloads/recap-graph.html` — open it in a browser."

Node size = message count. Color groups = date. Use when the user wants a visual
overview of activity over a period.

---

## One Thing

Every recap ends with One Thing — the single highest-leverage next action.

```
One Thing → [concrete, specific, one sentence]
```

Rules:
- Must name a specific file, feature, command, or decision — never a vague direction
- Prioritize: unfinished work > decisions blocking progress > things with momentum
- If multiple candidates, pick the one closest to done or most blocking

Examples of bad One Things:
- "Continue working on the project" ✗
- "Fix the bug" ✗

Examples of good One Things:
- "Run the Docker test suite to confirm scaffold --check passes before writing migration scripts" ✓
- "Merge the feature/supabase-migration branch — both phases are complete and tested" ✓
- "Write the `recap.md` workflow doc — recap SKILL.md references it and it's the last missing piece" ✓

---

## No Sessions Found

If `recap.py list` returns nothing for the date range:

1. Widen the range — try `last week` if `yesterday` was empty
2. Try topic mode on the same subject
3. If still nothing: tell the user honestly, suggest what to search instead
