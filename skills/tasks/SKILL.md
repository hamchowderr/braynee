---
name: tasks
description: >
  Create, complete, list, query, and time-track tasks via the mtn CLI
  (TaskNotes, file-based). Use when the user says "add task", "create task",
  "complete task", "mark done", "what are my tasks", "what should I work on",
  "what's overdue", "start a timer", "tasknotes", "what's on my list".
argument-hint: "[list | create TEXT | done TASK | search QUERY | timer start TASK | what-to-work-on]"
allowed-tools: Bash(mtn:*)
---

# Tasks (TaskNotes via mtn)

Manage tasks through **`mtn`** — the standalone TaskNotes CLI. It reads and
writes the task markdown files directly through `mdbase`.

**There is no HTTP API and no server.** `mtn` operates on files, so it works
whether or not Obsidian is running, with no port and no auth token. (TaskNotes
*does* ship an HTTP API, but braynee deliberately does not use it — the CLI is
the supported path. Never reach for `localhost:8080`/REST here.)

`mtn` is configured once (`~/.config/mdbase-tasknotes/config.json`) with
`collectionPath` pointing at the vault, so commands need no path argument.

## Reading tasks

Always pass `--json` when you need to reason over results.

```bash
mtn list --json                       # all tasks (open + done), structured
mtn list --status open --json         # only open
mtn list --overdue --json             # overdue
mtn list --priority high --json       # by priority
mtn list --tag task --json            # by tag
mtn list --due 2026-05-30 --json      # by due date
mtn search "<query>" --json           # full-text search
mtn show "<title-or-path>"            # full detail of one task
mtn stats                             # counts by status/priority
```

Each `list --json` item has: `path`, `title`, `status`, `priority`, `due`,
`scheduled`, `projects` (`["[[Project]]"]`), `contexts` (`["@ctx"]`),
`timeEstimate` (minutes), `tags`, `recurrenceAnchor`.

## Creating tasks

`mtn create` parses **natural language** — dates, priority, project, contexts,
and tags are extracted from the text. Write the task so it is self-contained:
enough context that it can be picked up later without the conversation.

```bash
# NLP: "tomorrow", "high", "+Project", "@context", "#tag" are all parsed
mtn create "Draft the Q3 proposal tomorrow high +ClientWork @writing"
mtn create "Call the dentist next monday"
```

Confirm what was created by echoing the resulting title back from
`mtn list --status open --limit 1 --json`.

## Completing / updating

```bash
mtn done "<title-or-path>"            # mark complete (alias: mtn complete)
mtn update "<title-or-path>" --details "context for later"
mtn archive "<title-or-path>"         # archive (keeps the file)
mtn delete "<title-or-path>"          # remove
```

## Time tracking

```bash
mtn timer start "<title-or-path>"     # start a timer on a task
mtn timer stop                        # stop the running timer
mtn timer status                      # what's running
mtn timer log                         # time entries
```

## "What should I work on?"

There's no single command — compose the picture, then reason over it. Pull the
inputs and recommend based on overdue first, then today's scheduled, then
high-priority open work, factoring `timeEstimate` against the time the user has.

```bash
mtn list --overdue --json                       # 1. overdue (do first)
mtn list --status open --due "$(date +%F)" --json   # 2. due/scheduled today
mtn list --status open --priority high --json   # 3. high-priority open
```

Surface a short ranked shortlist with titles, projects, and time estimates —
not the raw JSON.

## Relationship to beads

braynee already mirrors **beads** issues into TaskNotes automatically (the
`beads-status-sync` hook calls `mtn` on `bd create`/`--claim`/`close`). So:

- For tracked project work, create the **beads** issue — the TaskNote follows.
- Use this skill directly for standalone personal tasks, querying, "what should
  I work on", and timers — things that don't warrant a beads issue.

Don't hand-edit task files; go through `mtn` so the frontmatter stays valid.
