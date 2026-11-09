---
name: test-free-locally
description: >
  Find the free, local way to try or test a tool before paying or creating a
  cloud account: local stacks, emulators, test modes, sandboxes and in-browser
  versions (for example Supabase's local stack because it's Postgres underneath,
  Stripe test mode and CLI, WordPress Playground, self-hosted n8n or Coolify).
  Use when the user says "how do I test this", "do I need an account", "is there
  a free way", "can I try it first", or is about to pay to experiment.
---

# Test for free, locally, first

Almost every serious tool has a free way to try it without an account or a bill.
Usually it's because of what it's built on: if it's Postgres, Docker, WordPress
or open source underneath, it can run on your own computer.

## Steps

1. **Find what it's built on** (see `look-under-the-hood`). That often answers it.
2. **Look for each of these**, in the official docs:
   - a local version or command-line tool that runs the whole thing on your
     computer (for example `supabase start`, `docker compose up`, `npx n8n`);
   - a test mode or sandbox account (Stripe test mode and test cards);
   - an emulator or a CLI that forwards real events to your computer
     (`stripe listen`);
   - an in-browser version (WordPress Playground);
   - a free tier, and exactly where its limits are.
3. **Give the exact steps** to start it, in order, for the user's computer.
   Say what they need installed first (for example Docker).
4. **Say what the free local version can't show** (real email delivery, real
   payments, scale), so they know when paying is actually needed.

## What to give the user

The free option, the steps to start it, and a short "you'll only need to pay
when..." line.

## Rules

- Only list a free option you found in official docs; link it.
- Never ask for real payment details or production keys to test.
- Keep test data and real data apart.
