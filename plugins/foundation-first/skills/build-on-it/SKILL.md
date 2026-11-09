---
name: build-on-it
description: >
  Decide how to build on an existing project instead of from scratch, choosing
  the lightest option that works: use it as it is, configure it, extend it with
  a plugin or add-on, or fork it. Explains forking in plain words and what it
  costs to maintain. Use when the user says "can I change this", "should I fork
  it", "it almost does what I want", "how do I customise", or "what does forking
  mean".
---

# Build on it, don't rebuild it

There are four ways to build on someone else's work. Always pick the lightest
one that does the job.

| Level | What it means | Who keeps it working |
|---|---|---|
| **Use it** | Install it and change nothing | They do |
| **Configure it** | Change its settings, options, themes | They do |
| **Extend it** | Add to it without touching its files: a plugin, add-on, hook, webhook, theme, or a small app beside it | They maintain the core; you maintain your add-on |
| **Fork it** | Make your own full copy of their project and change it however you like | You do, from now on |

**Forking, in plain words:** you take a complete copy of someone's project into
your own account (on GitHub it's one button). The original keeps going without
you. You can still pull in their updates later, but the more you change, the
harder that gets, and fixing your copy is now your job. Fork when the first three
can't do it, or when the original has stopped and you need to carry it on (and
the licence allows it).

## Steps

1. List what the user needs that the project doesn't already do.
2. For each gap, check the lightest level that closes it: settings first, then
   official extension points (plugin system, hooks, API, webhooks), then fork.
3. Check the licence allows the chosen level (see `find-the-foundation`).
4. Recommend one level per gap, and estimate the upkeep in plain words.

## What to give the user

The gaps, the level chosen for each, why the lighter levels didn't work, and
what they'll need to maintain.

## Rules

- Never recommend editing a project's own files in place when an extension
  point exists; updates will wipe the change.
- If recommending a fork, say how they'll keep up with upstream updates.
