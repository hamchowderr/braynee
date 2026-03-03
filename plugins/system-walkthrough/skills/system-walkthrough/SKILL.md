---
name: system-walkthrough
description: >
  Autonomously reads through a codebase and produces a complete system walkthrough
  as Obsidian-compatible Markdown with wikilinks. Use this skill whenever the user
  asks to "document this codebase", "walk through this system", "create documentation
  for this project", "map out this repo", "explain this codebase", or any variation
  of wanting a comprehensive understanding of a codebase turned into documentation.
  Also trigger when the user says things like "I need docs for this", "help me
  understand this project", "reverse-engineer the docs", or "what does this codebase do".
  This works on any language, framework, or stack — it figures out what matters on its own.
---

# System Walkthrough

You are a senior architect handed a codebase you've never seen. Your job: read through
it systematically and produce a complete, interlinked walkthrough that someone could
use to fully understand how the system works. The output is an Obsidian-compatible
knowledge base with wikilinks connecting the pieces.

## How to think about this

Imagine onboarding a senior developer onto this project. They need to understand:
- What the system does (purpose, domain)
- How it's built (architecture, stack, key decisions)
- How the pieces connect (data flow, dependencies, integrations)
- Where the important logic lives (not every file — the ones that matter)

You are not generating API reference docs. You are writing a **walkthrough** — a
narrative that guides someone through the system with enough context to be productive.

## Phase 1: Survey

Get the lay of the land before reading any code in depth.

1. **Directory tree** — Run a 2-3 level directory listing to see the project shape.
2. **Identity files** — Read the files that tell you what this project is:
   - `package.json`, `requirements.txt`, `Cargo.toml`, `go.mod`, `composer.json`,
     `Gemfile`, `pom.xml`, `build.gradle`, or equivalent
   - `README.md` or any root-level docs
   - `.env.example`, `.env.local.example`, or similar config templates
   - `docker-compose.yml`, `Dockerfile`, deployment configs
   - Config files: `next.config.*`, `vite.config.*`, `tsconfig.json`, `pyproject.toml`, etc.
3. **Framework detection** — From the above, determine:
   - Language(s) and framework(s)
   - Database / ORM if any
   - Auth strategy if apparent
   - Deployment target if apparent
   - External services / APIs

After this phase, you should have a mental model of what you're looking at. Pause and
share a brief summary with the user as a progress update before proceeding.

## Phase 2: Deep Read

Now read through the codebase systematically. The goal is to understand, not to
document every file. Use judgment about what matters.

**Reading order** (adapt to what you find):

1. **Entry points** — The file(s) where execution starts. For web apps this is usually
   routing config, main app file, or the equivalent of `index.*` / `app.*` / `main.*`.
2. **Routes / endpoints** — What does this system expose? Read through route definitions,
   API handlers, page components, or CLI commands.
3. **Data layer** — Schema definitions, models, migrations, database config. How is data
   shaped and stored?
4. **Core business logic** — The files that do the actual work. Services, utilities,
   domain logic. Read the important ones; skim or skip boilerplate.
5. **Auth & middleware** — How does the system handle authentication, authorization,
   request processing?
6. **Integrations** — External API calls, webhook handlers, third-party service
   connections, queue consumers.
7. **Configuration** — Environment variables, feature flags, runtime config.

**What to skip or skim:**
- Generated files, lock files, build output
- Test files (note their existence but don't deep-read unless relevant)
- Vendor / node_modules / dependencies
- Static assets (images, fonts)
- Boilerplate that doesn't teach you anything

**While reading, track:**
- Key architectural decisions you notice
- Patterns and conventions the codebase follows
- Anything surprising, clever, or concerning
- How components depend on each other

## Phase 3: Produce the Walkthrough

Create the output as a set of interlinked Obsidian Markdown files.

### Output Structure

```
system-walkthrough/
├── index.md              # Start here — system overview and navigation
├── architecture.md       # How the system is built, stack, key decisions
├── data-model.md         # Database schema, models, relationships
├── routes-and-endpoints.md  # What the system exposes (API, pages, CLI)
├── core-logic.md         # Key business logic explained
├── integrations.md       # External services, APIs, webhooks
├── config-and-env.md     # Environment setup, configuration
└── glossary.md           # Project-specific terms, abbreviations
```

This structure is a starting point. **Adapt it to what you actually find.** If the
codebase has no database, skip `data-model.md`. If there's a complex auth system,
give it its own file. If there are 30 API endpoints, break `routes-and-endpoints.md`
into sub-files. Use your judgment.

### Writing Guidelines

**index.md** — This is the landing page. It should contain:
- One-paragraph summary of what the system does
- Tech stack at a glance
- A "Start here" section with wikilinks guiding the reader through the walkthrough
  in a logical order
- A complete list of all walkthrough files with brief descriptions

**Every other file** should:
- Open with a 1-2 sentence summary of what this section covers
- Use headers (##, ###) to organize content
- Use wikilinks (`[[other-file]]` or `[[other-file#section]]`) to cross-reference
  related content in other walkthrough files
- Include relevant code snippets where they clarify behavior (keep them short —
  enough to illustrate, not reproduce)
- Use callouts for important notes: `> [!note]`, `> [!warning]`, `> [!tip]`
- End with a "Related" section linking to connected walkthrough files

**Wikilink conventions:**
- Link to files: `[[architecture]]`
- Link to sections: `[[architecture#authentication]]`
- Link with display text: `[[data-model|the database schema]]`
- Use links liberally — if you mention something documented elsewhere, link it

**Tone:** Direct, technical, conversational. Like a senior engineer explaining the
system to a peer over coffee. Not dry API docs — a walkthrough someone actually
wants to read.

**Code snippets:** Include them when they clarify, not to pad length. Use the
actual code from the repo (simplified if needed) with file path references:

```
// src/lib/auth.ts
export async function validateSession(token: string) { ... }
```

### What makes a great walkthrough

- Someone new to the project can read `index.md` and know where to start
- Each file stands alone but links to related context
- Architectural decisions are explained (the "why", not just the "what")
- The reader finishes understanding how data flows through the system
- Nothing critical is missing, nothing trivial is over-explained

## Execution Notes

- **Progress updates:** After Phase 1 (Survey), share a brief summary with the user
  so they know you're on track. Something like "This looks like a Next.js app with
  Supabase backend, ~40 routes, auth via middleware. Diving into the code now."
- **Large codebases:** If the codebase is very large (100+ files of substance), focus
  on the most important paths first and note areas you skimmed. You can always do a
  deeper pass on specific areas if the user asks.
- **Monorepos:** If you detect a monorepo (multiple packages/apps), document each
  significant package as its own section or sub-folder within the walkthrough, with a
  top-level index explaining how they relate.
