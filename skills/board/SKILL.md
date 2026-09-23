---
name: board
description: >
  Build or refresh a repo's beads board — one published Artifact per repo that
  shows the backlog visually: status tiles, open PRs and deploys, epic progress,
  a board per milestone, the build-order diagram, a full record per issue,
  derived check-ins and a done archive. Every board is identical except its
  accent colour. Use when the user says "board", "update the board", "show the
  beads visually", "publish the backlog", "refresh the artifact", or at a
  check-in in a beads-tracked repo: after seeding, after a PR is opened, after
  a merge or close.
argument-hint: "[repo path] (defaults to the current repo)"
allowed-tools: Bash(node:*), Bash(bd:*), Bash(gh:*), Bash(git:*)
---

# Board — one visual beads board per repo

`scripts/board.mjs` turns a repo's beads data into one self-contained HTML page.
The generator lives in this skill, not in the repo, so every board has the same
layout and a fix here fixes every project. It is **read-only**: it runs
`bd export`, `bd comments`, `gh pr list` and `gh api` inside the repo, writes a
single file outside it, and refuses to write inside it. It never changes bd
data.

## When to run it

- Right after issues are seeded (`prd-seed`, `bd mol pour`, a manual batch).
- At every check-in: a PR opened, a PR merged, an issue closed or reopened.
- Whenever the user asks to see or refresh the board.

Keep one board per repo for the life of the project. Never publish a second.

## Steps

1. **Find the existing board.** Call the Artifact tool with `action: "list"`
   (raise `limit` if needed) and look for the title `<Project> Board`. If the
   URL is not in the listing, ask the user for it before creating a new one.
2. **Read it back** with `action: "read"` on that URL. The result names the
   saved HTML file. Pass that file as `--from` so the board keeps its name and
   accent colour: both are stored in `<meta name="board-name">` and
   `<meta name="board-accent">` inside the page.
3. **Generate** into the scratchpad directory (never the repo):

   ```bash
   node "<skill dir>/scripts/board.mjs" <repo> \
     --out "<scratchpad>/<project>-board.html" \
     --from "<saved file from step 2>"
   ```

   Options:
   - `--accent <#rrggbb>` sets the project colour. Use it on the first board, or
     to change the colour. Without it, and without `--from`, the default is a
     neutral teal.
   - `--name "<Project>"` overrides the name. The default is the repo folder
     name in title case.
   - `--log <file.json>` merges an older hand-kept log (`[{ "at", "note" }]`)
     into the check-ins. This is only for boards that predate this skill.

   The script prints one JSON line: issue, PR and deploy counts, lanes,
   milestones, diagram size and output bytes. Check the counts against
   `bd list` before publishing.
4. **Publish** to the existing URL: Artifact `publish` with `url` set to the
   board's URL and `file_path` set to the generated file. On a first board only,
   omit `url` and pass `icon: "board"`.
5. **First board only:** record the URL in the project's vault note and add one
   line to the central artifact index `3. Resources/Artifacts.md`. Write both
   through the `obsidian` CLI, following the vault rules; never edit vault files
   directly.

## What the page shows

| View | Contents |
|---|---|
| Status | Lane tiles (queued, ready, in progress, in review, done, deferred), open PRs with their issues and preview URL, the next ready issues, deploys from the last 30 days, and a progress card per open epic. |
| Board | One board per milestone with tabs and a progress bar, or a single board when the repo has no milestones. Five lanes plus a deferred strip. Done shows the 8 most recent. |
| Issues and build order | A diagram, left to right, where each issue sits one column after its deepest blocker or parent. Solid arrows are `blocks` links, green once the blocker is done. Dashed lines run parent to child. Every box and row opens the issue. |
| Issue record | Description, design, acceptance, notes, close reason, comments, parent and children, blocked by, unblocks, related links, PRs, execution metadata and dates. |
| Check-ins | Grouped by day: issues opened and closed, PRs opened, merged or closed, and notes. Days more than 14 days before the latest are collapsed. |
| Done | Every closed issue, newest first. |

How the data maps:

- **Lanes.** Closed means done. `deferred` means deferred. An issue with an open
  PR is in review. `in_progress` means in progress. `blocked`, or any open
  `blocks` dependency, means queued. Everything else is ready.
- **PR links.** `external_ref: gh-<n>` first. Otherwise, a PR whose branch,
  title or body names the full id, or whose body names the short id in
  backticks.
- **Milestones.** Labels of the form `milestone:<name>`, with underscores read
  as spaces, ordered by each milestone's first issue.
- **Diagram scope.** On a project with 80 issues or fewer, every issue is drawn.
  On a larger one, only groups that still hold open work are drawn, plus
  unconnected open issues.
- **Deploys.** GitHub deployments from the last 30 days, the latest per
  environment. A deploy whose ref matches an open PR's branch appears on that
  PR as its preview.
- **People.** Owner and comment author show only the part before an `@`, since
  boards are often shared by link.

## Leaving a note in the check-ins

Check-ins are derived; there is no log file to maintain. To add a human line
("why we changed the plan", "waiting on the client"), comment on the issue it
concerns:

```bash
bd comments add <issue-id> "Deferred until the client confirms the budget."
```

The comment appears as a highlighted note on its day, and on the issue's record.
For a note that concerns the whole project, comment on the epic or the
tracking issue.

## Checks before publishing

- Open the generated file at 375px and at 1280px wide. The page itself must not
  scroll sideways; only the diagram and the done table scroll inside their own
  boxes.
- Try `#status`, `#board`, `#issues`, `#log`, `#done` and one `#issue-<id>`.
  An unknown hash falls back to Status.
