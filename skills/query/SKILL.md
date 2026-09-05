---
name: query
description: >
  Search your vault using QMD (semantic + BM25). Find notes, decisions, resources,
  and connections. Use when user says "find", "search for", "what do I know about",
  "look up", "pull notes on", "where did I write about", "any notes on".
argument-hint: "[QUERY | --semantic QUERY | --deep QUERY | --context TERM]"
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

## Write the query fields yourself

`query` takes a structured document. Author each field — you know the goal, the
domain vocabulary, and the nearby-but-wrong concepts; the built-in expander does not.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qmd-wrapper.mjs query $'intent: what to find, and what to avoid\nlex: exact terms and aliases\nvec: the idea in the source own wording\nhyde: the answer you expect to find'
```

## Search Strategy

Run 2-3 angles on the same topic, mixing modes:
1. `search` with core keywords (split hyphenated terms — BM25 is literal and AND-based)
2. structured `query` with `intent:` plus `lex:`/`vec:`
3. `vsearch` with the concept in plain English

## When to Use Each Mode

| Mode | Use for |
|------|---------|
| `query` (structured) | The default. Conceptual recall, indirect wording, anything you can state an intent for |
| `search` | Titles, exact terms, code symbols, IDs, rare phrases |
| `vsearch` | A quick semantic pass with no lexical anchor |
| `search:context` | Finding where a specific phrase appears |

## Hits are leads, not answers

A result is a snippet. Before reporting a fact, decision, quote or number, retrieve
the source:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qmd-wrapper.mjs get "#docid"          # whole note, line-numbered
node ${CLAUDE_PLUGIN_ROOT}/scripts/qmd-wrapper.mjs get "#docid:40:20"    # 20 lines from line 40
node ${CLAUDE_PLUGIN_ROOT}/scripts/qmd-wrapper.mjs multi-get "#a,#b"     # several at once
```

Cite the docid. Add `-c vault` to scope a search, `-n <k>` for more hits.

## What Gets Indexed

All markdown files in the vault are indexed: notes, project files, PRDs, client notes,
resources, zettelkasten atoms, and session notes.
