# Testing Stack

Four tools, each covering a different layer. They stack — they don't overlap.

| Tool | Layer | What it tests |
|---|---|---|
| **Vitest** | Unit + integration | Pure functions, hooks, modules in isolation. Fast, runs in Node. |
| **Supertest** | API / HTTP boundary | Route handlers — fire a request, assert on the response. No browser. |
| **Playwright** | Browser / E2E | Real user flows — clicks, navigation, visual state. Multi-browser. |
| **AIMock / LLMock** | LLM boundary | Replaces the real LLM with a deterministic mock server so tests are fast, free, and repeatable. The other three tools use it as a dependency, not a replacement. |

## Pyramid

```
        ▲ Playwright    ← few, slow, full-stack
        │ Supertest     ← medium, hits the API
        │ Vitest        ← lots, fast, in-process
        │
AIMock runs alongside whenever an LLM is in the loop, hijacking calls via
ANTHROPIC_BASE_URL / OPENAI_BASE_URL so all three tiers stay deterministic.
```

## CLI install

The brainy `check-testing-setup` SessionStart hook nudges if any of these are missing.

```bash
# Vitest — unit + integration
npm i -D vitest @vitest/ui
npx vitest --version
# Docs: https://vitest.dev/guide/cli

# Playwright — E2E
npm i -D @playwright/test
npx playwright install
# Docs: https://playwright.dev/docs/getting-started-cli

# AIMock — deterministic LLM
npm i -D @copilotkit/aimock
npx aimock-cli init
# Docs: https://aimock.copilotkit.dev/aimock-cli/
```

Wire `package.json` scripts:
```json
{
  "scripts": {
    "test": "vitest",
    "test:e2e": "playwright test",
    "test:ai": "aimock-cli serve & vitest run --config vitest.ai.config.ts"
  }
}
```

CI should run all three on PR.

## Why these specifically

- **Vitest** — fastest dev loop. Watches and re-runs on save. Compatible with most things Jest does, with better TS + ESM support.
- **Supertest** — lets you test API routes without spinning up a browser. Pairs naturally with Vitest.
- **Playwright** — ships with codegen, trace viewer, and parallelization. Better than Cypress for multi-tab / multi-domain flows.
- **AIMock** — the difference between "tests sometimes fail because the LLM hallucinated" and "tests always pass or always fail for a real reason." Non-negotiable when an agent is part of the system.

## How not to mock too much

- Mock at *boundaries* (HTTP, LLM, database), not at the unit you're testing.
- A test that mocks the function it's testing is a test of the mock.
- Integration tests that hit a real (test) database catch class of bugs unit tests can't.

## Skip list

- **Jest** — Vitest does the same job with a better runtime story.
- **Cypress** — Playwright is faster, more flexible, and free.
- **Storybook for tests** — Storybook is a UI dev tool; use Playwright Component Testing if you need component-level visual tests.
