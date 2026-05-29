---
name: playwright
description: >
  Drive Playwright from the CLI for end-to-end browser testing and AI-assisted
  test authoring with Playwright Test Agents (Planner, Generator, Healer). Use
  when the user says "write e2e tests", "playwright", "browser test", "test a
  web page/app", "record a test", "codegen", "show the trace/report", "fix the
  failing e2e test", "heal my tests", "set up playwright agents", or wants to
  plan/generate/repair Playwright tests. Universal — runs via `npx`, assumes no
  global install.
allowed-tools: Bash(npx:*), Bash(node:*)
---

# Playwright

End-to-end browser testing (Chromium, Firefox, WebKit) plus an AI authoring loop
— the **Test Agents**. Everything runs through `npx`; **do not** assume a global
install and **do not** `npm i -g playwright`. If a project already depends on
`@playwright/test`, prefer its local version (`npx playwright ...` resolves it).

**Docs:** https://playwright.dev — Test Agents: https://playwright.dev/docs/test-agents

## First contact

Always discover the live command surface rather than guessing — it's version-specific:

```bash
npx playwright --help              # all commands for the resolved version
npx playwright <command> --help    # options for one command
npx playwright --version           # confirm version (Agents need >= 1.56)
```

If browsers aren't installed yet, the first run prompts for them:

```bash
npx playwright install             # download Chromium/Firefox/WebKit
npx playwright install chromium    # just one engine (faster)
npx playwright install-deps        # Linux/CI OS deps (asks for sudo)
```

## Core CLI

```bash
npx playwright test                      # run all tests
npx playwright test --grep "login"       # filter by title
npx playwright test path/to/spec.ts      # one file
npx playwright test --project=chromium   # one browser
npx playwright test --headed             # watch it run
npx playwright test --ui                 # interactive UI mode (debug, time-travel)
npx playwright test --debug              # step through with the inspector

npx playwright codegen localhost:3000    # record clicks → generated test code
npx playwright show-report               # open the last HTML report
npx playwright show-trace trace.zip      # open a saved trace (DOM + network + screenshots)
npx playwright screenshot <url> out.png  # one-off screenshot
npx playwright open <url>                # open a page in the bundled browser
```

`trace: 'on-first-retry'` and `screenshot: 'only-on-failure'` in
`playwright.config.ts` are the high-value defaults — they make `show-trace` and
the HTML report useful for diagnosing failures without slowing the happy path.

## Test Agents — the AI authoring loop

Playwright ships three agents that operate a **real browser over MCP** (they
observe the live DOM, they don't hallucinate selectors):

| Agent | Job |
|-------|-----|
| 🎭 **Planner** | Explores the running app and writes a human-readable Markdown test plan into `specs/`. |
| 🎭 **Generator** | Turns a plan into executable `*.spec.ts`, verifying every selector and assertion live as it goes. |
| 🎭 **Healer** | Runs the suite, replays failures, inspects the UI, patches broken locators/waits, and re-runs until green. |

Use them independently, in sequence (plan → generate → heal), or chained in an
agentic loop.

### Setup — scaffold the agents INTO THE TARGET PROJECT (not into this plugin)

The agent definitions are **versioned with Playwright and regenerated on
upgrade**, and they assume a `seed.spec.ts` + `specs/` in the project under test.
So they belong in the project you're testing, freshly generated — **never** copy
a frozen set into braynee. When the user wants the agents, run this **in their
project's repo root**:

```bash
npx playwright init-agents --loop=claude
```

This writes Claude Code agent definitions (Planner/Generator/Healer), a `specs/`
dir, and a `seed.spec.ts`. Other loop providers exist if asked:
`--loop=vscode`, `--loop=copilot`, `--loop=opencode`. Add `--prompts` to also
emit prompt files. Re-run it after a Playwright upgrade to refresh the agents.

Requires Playwright **>= 1.56** — verify with `npx playwright --version` first.

### Working the loop

1. **Seed** — make sure `seed.spec.ts` points at the app and sets up auth/baseURL.
2. **Plan** — ask the Planner to explore a flow; review the Markdown in `specs/`.
3. **Generate** — hand a plan to the Generator; it writes verified `*.spec.ts`.
4. **Run** — `npx playwright test` (use `--ui` to inspect).
5. **Heal** — on failures, the Healer diagnoses and patches, then re-runs.

## Notes

- Universal by design: this skill prescribes `npx` so it works in any project on
  any machine — there is no machine-global Playwright dependency.
- The agents need the app actually running (or a `webServer` block in
  `playwright.config.ts` that starts it). Point `seed.spec.ts`/`baseURL` at it.
- For CI, `retries: process.env.CI ? 2 : 0` plus the trace/screenshot defaults
  above give debuggable failures without flake noise.
