---
name: read-every-source
description: >
  Answer questions about a tool, SDK or platform by checking more than one
  source: the official docs (and their AI-readable llms.txt version), the
  platform's own skills, plugins and MCP servers, the source code itself, and the
  changelog, issues and recent pull requests. Cite where each part came from and
  flag where sources disagree. Use when the user asks how something works, why
  something broke after an update, "is this still the right way", or before
  writing code against an outside service.
---

# Read every source

The docs are one source, not the only one. Busy teams ship changes before the
docs catch up, and some things are never written down. That's normal and nobody's
fault; it's why you check more than one place.

## Where to look, in order

1. **Official docs.** Start with the vendor's own pages, not blog posts or old
   tutorials. Check for an AI-readable version: `llms.txt` / `llms-full.txt` at
   the docs root, or a docs MCP server. (The braynee `docs-lookup` skill pulls
   these into a folder; `defuddle` cleans up a single page.)
2. **The platform's own AI tools.** Many platforms publish official skills,
   plugins or an MCP server (a connector that lets the AI use the service). These
   are written by the people who build the service. Use them when present.
3. **The code itself.** If it's open source, download it locally
   (`git clone --depth 1 <repo>`) and read the relevant files. The code is what
   actually runs, so when sources disagree, the code wins.
4. **Changelog, open issues and recent pull requests.** New options, known bugs
   and workarounds appear here weeks before the docs.

## Steps

1. Say which version the user is on (or ask once if it matters).
2. Check at least two of the four places above; check the code whenever it's open.
3. Answer, then list each claim with its source (page, file and line, issue).
4. Call out any place where sources disagree, and which one you trusted and why.

## Rules

- Never present a blog post or memory as the source when an official one exists.
- Say "I couldn't confirm this" instead of filling a gap with a guess.
- Read the whole relevant section, not one snippet out of context.
- Only read code that its owners have published, under its licence. Never
  reverse engineer closed software, decompile apps, or dig through private or
  undocumented APIs. If something isn't published, say so and stop there.
