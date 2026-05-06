---
name: tasks
description: >
  Create, complete, list, and query tasks via Obsidian TaskNotes.
  Use when user says "add task", "create task", "complete task", "what are my tasks",
  "mark done", "tasknotes", "what's on my list", "open tasks".
argument-hint: [list | create TASK | complete ID | search QUERY]
allowed-tools: Bash(node:*)
---

# TaskNotes Skill

Manage tasks through the Obsidian TaskNotes plugin API.

## Commands

```bash
# List open tasks
node ~/.claude/scripts/tasknotes-wrapper.mjs list

# List tasks for a project
node ~/.claude/scripts/tasknotes-wrapper.mjs list --project "ProjectName"

# Create a task
node ~/.claude/scripts/tasknotes-wrapper.mjs create "Task description" --project "ProjectName"

# Complete a task
node ~/.claude/scripts/tasknotes-wrapper.mjs complete TASK_ID

# Search tasks
node ~/.claude/scripts/tasknotes-wrapper.mjs search "keyword"

# Overdue tasks
node ~/.claude/scripts/tasknotes-wrapper.mjs list --overdue
```

## TaskNotes API

TaskNotes exposes a local REST API when Obsidian is running.
Default: `http://localhost:27123`

Endpoints:
- `GET  /tasks`           — list all tasks
- `POST /tasks`           — create task
- `PUT  /tasks/:id`       — update task
- `DELETE /tasks/:id`     — delete task

## Behavior

- Always create tasks through this skill, never manually edit task files
- Tasks are linked to projects via frontmatter
- Completed tasks are archived, not deleted
- Due dates use ISO format: YYYY-MM-DD
