---
name: write-your-rules
description: >
  Turn how the user builds, tests and what they never want into a short rules
  file their AI reads at the start of every job (CLAUDE.md, AGENTS.md or the
  tool's equivalent), and add a line or an automatic check every time something
  goes wrong. Use when the user says "remember this", "don't do that again",
  "every time you", "set up my project for AI", or after a mistake.
---

# Write your rules down

An AI starts every job fresh. A rules file it reads first is how your way of
working carries over: how you build, how you test, what never to do. Every
mistake becomes one more line, or better, an automatic check.

## Steps

1. **Find or create the rules file** the user's AI tool reads at the start
   (Claude Code: `CLAUDE.md`; many tools: `AGENTS.md`). Keep one per project.
2. **Keep it short and concrete.** Sections that work well:
   - what the project is, and a map of its folders;
   - how to build and the exact checks to run before calling work done;
   - how to test (the free local way first);
   - rules for every change (one line each, imperative: "Use the official SDK
     for every service.");
   - words or things never to use.
3. **After a mistake**, add one line that would have prevented it. If a tool can
   check it automatically (a linter rule, a test, a CI step), add that instead
   and note it in the file.
4. **Read it back** to the user in plain words and confirm it matches how they
   work.

## Rules

- One rule per line, no essays. If a rule needs a paragraph, it belongs in docs.
- Never put passwords, keys or private customer data in the rules file.
- Remove rules that are no longer true; stale rules are worse than none.
