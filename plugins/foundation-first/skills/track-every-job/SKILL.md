---
name: track-every-job
description: >
  Give every piece of work a tracked issue before it starts, link it to the
  change (branch, pull request, status) and close it when the change is live,
  so the user always knows what's done, what isn't and why anything changed.
  Works with Beads, GitHub Issues, Linear or any tracker the user has. Use when
  starting any task, when the user asks "what's left", "what did we do", "why
  did this change", or wants a project board.
---

# Track every job

One issue per piece of work, linked to its change, closed when it's live.
Months later, any change can be traced back to why it was made.

## Steps

1. **Pick the tracker** the user already has. If they have none, suggest a free
   one: GitHub Issues for a repo, or Beads (`bd`), an open-source tracker that
   lives in the repo and that AI agents can use directly.
2. **Before starting work**, search for an existing issue to avoid duplicates;
   create one if none exists. Title: short and plain. Body: what's wanted, and
   how we'll know it's done.
3. **Link it**: put the issue id in the branch name, the commit or pull request,
   and status updates.
4. **Close it** only when the change is live (merged and deployed, or published),
   with one line on what changed.
5. **Bigger asks get a parent issue** (an epic) with child issues per piece.

## Optional, with braynee

The braynee plugin's `pour` skill turns a recipe into a linked set of Beads
issues, and its `board` skill publishes a visual board per repository.

## Rules

- Never close an issue for work that isn't live yet.
- Keep private data (customer names, server addresses, keys) out of issue titles
  that may be shown publicly.
