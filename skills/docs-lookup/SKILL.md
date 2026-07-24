---
name: docs-lookup
description: >
  Pull clean, current docs for a tool/SDK into a target dir using the
  index + on-demand + curated-copies model (never a full site mirror). Use when
  the user says "get the docs for X", "pull the llms.txt", "find <tool>'s docs",
  "mirror these API docs", "add <site>'s docs to the vault", "grab the latest
  <framework> docs", or wants an offline/searchable copy of a library's docs.
argument-hint: "[index <domain> <target-dir> [\"Note Name\"] | pages <target-dir> <url>...]"
allowed-tools: Bash(node:*)
---

# docs-lookup — clean docs on demand (llms.txt model)

Put a tool/SDK's docs where you can search them, without crawling the whole site.
Backed by `${CLAUDE_PLUGIN_ROOT}/scripts/mirror-llms-docs.mjs` (Node built-in
`fetch`, zero deps, cross-platform).

## The model — three layers, in order

1. **Index (always).** A site's root `llms.txt` is a curated link-map of its docs.
   Save it once as a navigable index note. This is the map, not the territory.
2. **On-demand (default).** When you actually need a page, fetch that one page's
   clean-markdown route right then. Don't pre-copy pages you don't use.
3. **Curated copies (sparingly).** Copy verbatim only the handful of pages you
   reference constantly (kept minimal, stamped `verbatim-copy`, re-fetched to refresh).

Never mirror a whole site. Verbatim-or-link: copied pages are stored as-is and
never hand-edited — re-run the fetch to refresh.

## Run it

```bash
# 1. Save the root llms.txt as an index note in <target-dir>
node "${CLAUDE_PLUGIN_ROOT}/scripts/mirror-llms-docs.mjs" index <domain> <target-dir> ["Note Name"]
#    e.g.
node "${CLAUDE_PLUGIN_ROOT}/scripts/mirror-llms-docs.mjs" index mastra.ai "<target-dir>" "Mastra Docs Index"

# 2. Copy specific clean pages verbatim into <target-dir>
node "${CLAUDE_PLUGIN_ROOT}/scripts/mirror-llms-docs.mjs" pages <target-dir> <clean-page-url> [<clean-page-url> ...]
```

`<target-dir>` is whatever folder should hold the docs (a vault docs folder, a
repo `docs/` dir, a scratch dir). The script hardcodes no paths.

## Per-site clean-page routes

| Site   | Root index                          | Clean per-page route                                                                 |
|--------|-------------------------------------|--------------------------------------------------------------------------------------|
| Mastra | `https://mastra.ai/llms.txt`        | append `.md` (e.g. `.../docs/agents/overview.md`) — the `/llms.txt` per-page route was retired 2026-07-04 |
| Docker | `https://docs.docker.com/llms.txt`  | append `.md` (e.g. `.../engine/install.md`)                                           |
| other  | `https://<domain>/llms.txt`         | check the site's own retrieval guidance for its clean-page route                      |

If a site publishes `/llms-full.txt`, that's the whole-docs bundle — use it only
when you truly need everything; prefer the index + per-page routes.

## Rules

- **No crawling.** Index + explicit page URLs only; never spider a site.
- **Verbatim-or-link.** Copied pages are stored verbatim; to update, re-fetch.
- **Curated layer stays minimal.** Only pages you use constantly get a local copy.
- **No secrets.** Plain `fetch`, no Firecrawl/Infisical/tokens.
- **Generic.** Always pass an explicit `<target-dir>`; the script ships zero
  user-specific paths.
