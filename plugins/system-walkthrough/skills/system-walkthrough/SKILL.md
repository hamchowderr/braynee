---
name: system-walkthrough
description: >
  Autonomously reads through a codebase and produces a visual system walkthrough
  using Mermaid diagrams in Obsidian-compatible Markdown. Generates architecture
  diagrams, data flow charts, sequence diagrams, and entity relationship diagrams
  that visually explain how the application works — like an Excalidraw board but
  generated from code. Use this skill whenever the user asks to "document this
  codebase", "walk through this system", "create documentation for this project",
  "map out this repo", "diagram this app", "explain this codebase", or any variation
  of wanting a visual understanding of how a codebase works. Also trigger when the
  user says things like "I need docs for this", "show me how this app works",
  "reverse-engineer the architecture", or "what does this codebase do".
  This works on any language, framework, or stack.
---

# System Walkthrough

You are a senior architect handed a codebase you've never seen. Your job: read through
it systematically and produce a **visual walkthrough** — a set of Mermaid diagrams
embedded in Obsidian-compatible Markdown that show how the system works. Someone should
be able to look at your diagrams and understand the entire application without reading
a single line of source code.

Think of this like creating an Excalidraw board: architecture boxes, data flowing
between them, sequences showing how requests move through the system. Except you're
generating it as Mermaid so it renders natively in Obsidian.

## How to think about this

The output should answer these questions visually:

- **What is this?** → High-level architecture diagram showing all major components
- **How does data flow?** → Flowcharts showing request paths from user action to response
- **What talks to what?** → Sequence diagrams for key user flows
- **How is data shaped?** → Entity relationship diagrams for the data model
- **What are the layers?** → Component diagrams showing the dependency tree

Text is supporting context for the diagrams, not the main event. Every section should
lead with a diagram, then explain what you're looking at.

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

After this phase, share a brief summary with the user before proceeding.

## Phase 2: Deep Read

Read through the codebase systematically. While reading, you're specifically looking
for things that become diagrams:

**What to map:**

1. **Entry points and routing** — What comes in and where does it go? This becomes
   your architecture overview and request flow diagrams.
2. **Data layer** — Schema, models, relationships. This becomes your ER diagram.
3. **Core user flows** — The 3-5 most important things a user does in the app. Each
   becomes a sequence diagram showing the full request lifecycle.
4. **External integrations** — APIs, webhooks, third-party services. These become
   nodes in your architecture diagram.
5. **Auth and middleware** — How requests are intercepted and validated. This becomes
   part of your flow diagrams.

**What to skip:** Generated files, lock files, tests, node_modules, static assets,
boilerplate that doesn't teach you anything.

## Phase 3: Produce the Walkthrough

Create interlinked Obsidian Markdown files. Every file is diagram-first.

### Output Structure

```
system-walkthrough/
├── index.md                  # Overview + master architecture diagram
├── architecture.md           # Component diagram + tech stack breakdown
├── data-model.md             # ER diagram + schema explanation
├── flows/
│   ├── overview.md           # High-level request flow diagram
│   ├── [flow-1].md           # Sequence diagram for key flow 1
│   ├── [flow-2].md           # Sequence diagram for key flow 2
│   └── [flow-3].md           # Sequence diagram for key flow 3
├── integrations.md           # External services diagram
└── glossary.md               # Project-specific terms
```

Name the flow files after what they document (e.g., `user-authentication.md`,
`order-checkout.md`, `ai-chat-generation.md`). Adapt the structure to what you
actually find — skip what doesn't exist, add what's needed.

### Diagram Guidelines

**Use these Mermaid diagram types:**

1. **Architecture overview** (in `index.md`) — Use `graph TD` or `graph LR` to show
   all major components and how they connect:

   ```mermaid
   graph TD
       Client[Browser] --> NextJS[Next.js App Router]
       NextJS --> Auth[Supabase Auth]
       NextJS --> API[API Routes]
       API --> DB[(PostgreSQL)]
       API --> External[External APIs]
   ```

2. **Entity Relationship diagrams** (in `data-model.md`) — Use `erDiagram` to show
   the database schema:

   ```mermaid
   erDiagram
       USER ||--o{ WORKSPACE : belongs_to
       WORKSPACE ||--o{ PROJECT : contains
       PROJECT ||--o{ CHAT : has
   ```

3. **Sequence diagrams** (in `flows/`) — Use `sequenceDiagram` for key user flows
   showing the full lifecycle of a request:

   ```mermaid
   sequenceDiagram
       actor User
       User->>Browser: Clicks "Generate"
       Browser->>API: POST /api/chat
       API->>Auth: Validate session
       Auth-->>API: OK
       API->>AI: Stream completion
       AI-->>API: Tool call: run code
       API->>Sandbox: Execute code
       Sandbox-->>API: Result
       API-->>Browser: Stream response
   ```

4. **Flowcharts** (in `flows/overview.md`) — Use `flowchart TD` for decision trees
   and request routing:

   ```mermaid
   flowchart TD
       Request --> Middleware{Auth Check}
       Middleware -->|Authenticated| Router
       Middleware -->|Anonymous| Login
       Router --> API_Route
       Router --> Page_Route
   ```

5. **Component/dependency diagrams** (in `architecture.md`) — Use `graph TD` to show
   how packages or modules depend on each other.

**Diagram quality rules:**
- Every diagram must have a brief title comment above it explaining what you're looking at
- Keep diagrams focused — one concept per diagram. Split large diagrams into multiple.
- Use clear, descriptive labels on nodes and edges — no abbreviations without explanation
- Color-code or group related components using subgraph blocks
- Include the actual names from the codebase (file names, function names, route paths)
  so diagrams map directly to source code

### Writing Guidelines

**index.md** — The landing page. Contains:
- One-paragraph summary of what the system does
- Tech stack table at a glance
- **The master architecture diagram** — this is the single most important visual
- A "Start here" section with wikilinks in reading order
- Links to all walkthrough files

**Every other file** should:
- **Lead with a diagram** — the diagram is the main content
- Follow with concise explanatory text that adds context the diagram can't show
- Use wikilinks (`[[other-file]]`, `[[other-file#section]]`) to cross-reference
- Use callouts (`> [!note]`, `> [!warning]`, `> [!tip]`) for important context
- Include short code snippets only when they clarify what the diagram shows
- End with a "Related" section linking to connected files

**Wikilink conventions:**
- `[[architecture]]`, `[[data-model]]`
- `[[flows/user-authentication]]`
- `[[data-model|the database schema]]`

**Tone:** Direct, visual-first. The diagrams do the heavy lifting. Text explains
the "why" and fills in details that diagrams can't capture.

### What makes a great visual walkthrough

- Someone can look at `index.md` and understand the entire system in 60 seconds
- The ER diagram matches the actual database schema
- Sequence diagrams trace real request paths through actual files and functions
- You could hand this to a new developer and they'd know where everything is
- Diagrams use real names from the codebase, not generic placeholders

## Execution Notes

- **Progress updates:** After Phase 1, share what you found. After Phase 2, share
  which flows you plan to diagram before producing output.
- **Prioritize the diagrams:** If you're running low on context, prioritize the
  architecture overview, ER diagram, and the 2-3 most important sequence diagrams.
  Those alone give 80% of the understanding.
- **Large codebases:** Focus on the critical paths. Note areas you skimmed.
- **Monorepos:** Create a top-level architecture diagram showing how packages relate,
  then drill into each significant package.
