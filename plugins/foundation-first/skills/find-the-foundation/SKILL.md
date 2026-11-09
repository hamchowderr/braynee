---
name: find-the-foundation
description: >
  Before building anything, find what already exists: open-source projects,
  official tools and platforms that already do most of the job, who maintains
  them, how alive they are, and what their licence allows. Use when the user says
  "I want to build", "I have an idea for", "how would I make", "is there something
  that does", "should I build this myself", or starts a new app, automation,
  website or tool. Plain language; works for non-technical users.
---

# Find the foundation first

Most things people want to build already have a foundation: a free, open project
that has done the hard part for years. Starting there is faster, cheaper and
safer than starting from a blank page. Your job is to find it before any building
starts, and to explain it so anyone can follow.

## Steps

1. **Restate the goal in one sentence**, in the user's words. Ask one short
   question only if the goal is truly unclear.
2. **Break it into the hard parts** (for example: sign-in, payments, a database,
   email, a website editor, scheduling). The foundation should cover most of these.
3. **Search for candidates.** Look for open-source projects and official tools
   that already do most of it. Check the project's own site and code host, not
   only blog posts. Aim for 3 to 5 real candidates.
4. **Check each one**, and say where each fact came from:
   - Who maintains it (a company, a foundation, a community, one person)?
   - When was the last release? How often do releases come?
   - How many people use it or contribute to it?
   - What is the licence, and what does it let the user do: use it in a
     business, change it, sell what they build on it? (Explain in plain words:
     MIT and Apache are very open; GPL is open but changes you share must stay
     open; "source available" or custom licences may restrict business use.)
   - Can it run for free on their own computer? (See `test-free-locally`.)
5. **Recommend one**, with the reason, and say what it does NOT cover.

## What to give the user

A short table: candidate, what it covers, maintained by, last release, licence in
plain words, free to try locally (yes/no). Then one recommendation and the gaps
left to fill.

## Rules

- Never invent a project, version, date or licence. If you can't check it, say so.
- Prefer projects with recent releases and more than one maintainer.
- Explain every technical word the first time you use it.
- Building from scratch is the last option, not the first. If nothing fits, say
  why each candidate failed.
