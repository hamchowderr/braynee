---
name: query
description: >
  Search your vault using QMD (semantic + BM25). Find notes, decisions, resources,
  and connections. Use when user says "find", "search for", "what do I know about",
  "look up", "pull notes on", "where did I write about", "any notes on".
argument-hint: [QUERY | --semantic QUERY | --deep QUERY | --context TERM]
allowed-tools: Bash(node:*)
---

# Query Skill

Searches your vault via QMD. Three modes: exact match (BM25), conceptual (semantic vector),
and deep research (multi-pass).

## Commands

```bash
# Exact/keyword search (fastest)
node ${CLAUDE_PLUGIN_ROOT}/scripts/qmd-wrapper.mjs search "QUERY"

# Semantic / conceptual search
node ${CLAUDE_PLUGIN_ROOT}/scripts/qmd-wrapper.mjs vsearch "QUERY"

# Deep research — runs multiple angles, CPU-bound
node ${CLAUDE_PLUGIN_ROOT}/scripts/qmd-wrapper.mjs query "QUERY"

# Literal search with line context
obsidian search:context query="TERM" format=json
```

## Search Strategy

For best results, run 2-3 different searches on the same topic:
1. `search` with core keywords (split hyphenated terms — BM25 is literal)
2. `vsearch` with the concept in plain English
3. `search` with related terms or synonyms

## When to Use Each Mode

| Mode | Use for |
|------|---------|
| `search` | Finding notes by title, exact terms, IDs |
| `vsearch` | "What do I know about X?" type questions |
| `query` | Deep research across the vault, needs time |
| `search:context` | Finding where a specific phrase appears |

## What Gets Indexed

All markdown files in the vault are indexed: notes, project files, PRDs, client notes,
resources, zettelkasten atoms, and session notes.
