---
paths:
  - "**"
---

# Dev Defaults

Sensible defaults for development work. Deviate only with a concrete reason — and say so.

## Vault-first — check it before deciding, asking, or guessing
The vault is the source of truth for the stack, conventions, and tool docs below. Before asking a stack/architecture/convention question or assuming an answer, **search the vault** — the answer is almost always already there.
- Search with QMD (the only search tool — never grep/find/Glob the vault): `node ${CLAUDE_PLUGIN_ROOT}/scripts/qmd-wrapper.mjs search "terms"` (BM25) or `node ${CLAUDE_PLUGIN_ROOT}/scripts/qmd-wrapper.mjs vsearch "concept"` (semantic). Braynee's per-prompt hook injects this same command with the path already resolved — if you see it in context, use that copy verbatim.
- The `→ Vault:` paths below are canonical reference docs — read them on demand before deciding.

General: run a tool's `--help` before writing code against it; prefer the CLI over MCP when both exist; reach for a CLI before a web dashboard.

## Auth → {{auth_provider}}
Default auth provider is **{{auth_provider}}**. Use its CLI / SDK setup — don't hand-roll sessions or token handling.
→ Vault: `2. Areas/Development/Auth/{{auth_provider}}/`

> **Fill `{{auth_provider}}`** with your default (e.g. Clerk, Auth.js, Supabase Auth, NextAuth). Delete this block if you don't have one.

## LLM / agent work → {{agent_framework}}, backend-first
- Build any LLM or agent feature as a standalone **{{agent_framework}}** service.
- Scaffold via the framework's CLI or a template — don't hand-assemble.
- Get the agent working and testable as a **service** before building any UI.
→ Vault: `2. Areas/Development/AI/{{agent_framework}}/`

> **Fill `{{agent_framework}}`** (e.g. Mastra, LangGraph, Vercel AI SDK). Delete this block if not building agentic systems.

## Databases — separate layers, pick by need
Version-controlled SQL (e.g. Dolt) and the application backend (e.g. Supabase / Convex / Postgres+Prisma) are not interchangeable; they solve different problems.

- **Version-controlled SQL** — branch / diff / merge / commit on data. Use when you need data history, audit trails, lineage, or reproducible state. `add` + `commit` after every schema/data change.
- **Application backend** — realtime, auth, serverless/edge functions, storage, vector search. Use the CLI; let it generate types + migrations.

> **Fill in your specific picks** (e.g. "Dolt for agent state, Supabase for the app"). Delete blocks you don't use.

## Frontend / UI → {{frontend_kit}}
- Components are **{{frontend_kit}}**. Prefer composing from your existing component catalog over hand-rolling.

> **Fill `{{frontend_kit}}`** (e.g. shadcn/ui, Mantine, Chakra). Delete if backend-only.

## Linting / formatting → {{linter}}
One tool for both is preferred (e.g. Biome over ESLint + Prettier). `{{linter}} check .` should be the CI gate. Run format passes in their own commits so they don't bloat feature diffs.

> **Fill `{{linter}}`** (e.g. Biome, ESLint+Prettier, Ruff). Delete if not relevant.

## Secrets
Never read or print secret values — inject at runtime. See the `secrets` rule for the full contract.
