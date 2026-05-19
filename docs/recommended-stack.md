# Recommended Stack

The author's go-to choices for new builds. **Recommendations, not requirements** — braynee works with any stack.

## Frontend

| Choice | Why |
|---|---|
| **Next.js (App Router)** | Server components, streaming, edge runtime, Vercel-native. Most projects already need a React frontend; App Router consolidates that with the API. |
| **Tailwind CSS + shadcn/ui** | Tailwind for utility CSS, shadcn for accessible primitives you can copy and own. No design-system lock-in. |
| **Streamdown** | Streaming markdown renderer for AI chat UIs — handles incremental tokens, code blocks, math. |

## Backend / Data

| Choice | Why |
|---|---|
| **Convex** | Reactive DB + serverless functions in TypeScript. Live queries replace most polling. Pairs naturally with Mastra. |
| **Dolt** | MySQL-compatible with git-style version control. Use for any data you want to commit + diff over time. |
| **Turso (LibSQL)** | Embedded SQLite at the edge. Default for Mastra agent memory + workflow state. |

## AI / Agents

| Choice | Why |
|---|---|
| **Mastra** | Workflow engine for agentic systems. Steps, tools, branches, retries, durable memory. Agents deploy anywhere — own server, MCP, A2A, REST. |
| **Vercel AI SDK** | Unified `generateText` / `generateImage` / `streamText` across providers. Mastra leverages it for image gen (FLUX, Nano Banana, etc.). |
| **Anthropic Claude** | Default LLM for agent reasoning. Fall back to OpenAI / Google for specific capabilities (image gen, voice). |

## Auth + Payments

| Choice | Why |
|---|---|
| **Clerk** | Drop-in auth with React + Next.js integration. SSO, MFA, organizations, webhooks all included. |
| **Stripe** | Standard. Use Payment Links for fastest MVP; checkout sessions when you need more control. |

## Infra

| Choice | Why |
|---|---|
| **Vercel** | Deploy frontend + API + edge functions. Preview URLs per PR. |
| **Coolify (Hostinger VPS)** | Self-hosted services that don't fit Vercel — Mastra agent fleets, Convex self-host, n8n, etc. |
| **Infisical** | Secrets manager. Inject env vars at runtime via `infisical run`. Never commit `.env`. |

## Tooling

| Choice | Why |
|---|---|
| **Beads** | Issue tracker with git-style versioning. Source of truth for work. |
| **TaskNotes (mtn)** | Personal task layer in Obsidian. Mirrored from beads automatically by braynee. |
| **QMD** | Local BM25 + semantic search across the vault. Fast, no API calls. |

## What to skip

- **Bare Express APIs** when Next.js Route Handlers + Convex cover the use case
- **Custom auth** when Clerk solves it in 30 minutes
- **Self-hosted Postgres** for greenfield projects — Convex or Turso are faster to get started
- **n8n for code-able workflows** — n8n is great for connecting third-party SaaS but not for logic you'd rather own in code
