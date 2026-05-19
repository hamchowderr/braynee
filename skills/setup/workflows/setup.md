# Setup Workflow

Full step-by-step process Claude follows when `/setup` is invoked.

---

## Step 1: Detect Environment

Run silently before asking anything.

```bash
python3 {baseDir}/scripts/detect-env.py --all --claude --json
```

Capture: vault path, OS, installed tools, note apps, email/calendar platform,
existing hooks, and statusline configuration.
Do not show output to user yet.

**Branch on vault detection:**

- **No vault found** → proceed to **Step 1A** then Step 2 (full wizard — fresh install path)
- **Vault found** → run **Step 1A** then jump to **Step 1B** (existing vault path)

---

## Step 1A: Verify Required Toolchain

Brainy has hard dependencies — **do not assume any of them exist**. Setup itself
uses every one: `git` (vault git init + the Obsidian Git auto-backup the plugin
configures), `node` (every hook/monitor/bundled script), `python3` (these setup
scripts), `bd` (Beads is mandatory for all code projects), and QMD (search index).

Run silently:

```bash
python3 {baseDir}/scripts/detect-env.py --toolchain --json
```

This returns `{ toolchain: { found, missing, install, all_present } }` with
**OS-appropriate install commands** for anything missing.

**If `all_present` is true** → continue (also confirm QMD: `node ${CLAUDE_PLUGIN_ROOT}/scripts/qmd-wrapper.mjs status` — if it errors, treat QMD as missing below).

**If anything is missing**, do not silently proceed — the wizard will fail later
(Step 9 runs `git init` and `bd init`; hooks need `node`). Show the user one
consolidated prompt listing each missing tool with its install command, e.g.:

```
Brainy needs these before setup can run. The following are missing:

  • git    → winget install --id Git.Git -e
  • bd     → irm https://raw.githubusercontent.com/gastownhall/beads/main/install.ps1 | iex

Install them now? [Yes, install / I'll do it myself / Skip checks (not recommended)]
```

- **Yes, install** → run each install command (one at a time, surfacing output),
  then re-run `detect-env.py --toolchain --json` to confirm. Repeat once if a
  PATH refresh is needed (tell the user to reopen the shell if a command is
  still not found after install).
- **I'll do it myself** → stop the wizard with the list above; tell the user to
  re-run `/setup` once the tools are installed.
- **Skip checks** → continue but warn that Step 9 (Git/Beads init) and hooks
  will fail for any missing tool.

git is **not optional** — the vault is a git repo and the plugin configures
auto-commit/auto-push via Obsidian Git. Treat a missing `git` exactly like a
missing `node` or `bd`: block or guide, never skip silently.

---

## Step 1B: Existing Vault — Audit & Offer

Run all three detection tools silently:

```bash
python3 {baseDir}/scripts/scaffold.py --vault "{vault_path}" --check
python3 {baseDir}/scripts/settings-writer.py detect
python3 {baseDir}/scripts/install-obsidian-plugins.py --vault "{vault_path}" --check
```

Present a single consolidated menu showing only what's **missing**:

```
Found your vault at {vault_path}.

Here's what the second-brain plugin can add:

  Vault structure
  [ ] Context files (about-me, about-business, priorities, voice)
  [ ] CLAUDE.md — vault context file for Claude Code
  [ ] connections.md — Tier-1 domain registry
  (only shown if missing from vault)

  Claude Code integrations
  [ ] Vault context in every session
      Reads your CLAUDE.md at each session start
  [ ] Session tracking
      Saves a note to Sessions/ when each session ends
  (only shown if hook not already configured)

  Obsidian plugins
  [ ] Dataview, Tasks, Templater, Calendar, Obsidian Git
  (only shown if plugin not already installed)

Select what you'd like added (comma-separated numbers, or "all", or Enter to skip):
```

Apply exactly what was selected. Skip to Step 11 when done.

---

## Step 2: Collect 4 Inputs

Ask these in sequence. Do not ask anything else.

```
What's your name?
> ___

Company name? (type "personal" to skip company section)
> ___

Company website? (optional — press Enter to skip)
> ___

LinkedIn or Twitter/X handle? (optional — press Enter to skip)
> ___
```

---

## Step 3: Scan for Projects

Run immediately after Step 2 (or in parallel while waiting for answers).

```bash
python3 {baseDir}/scripts/scan-projects.py --json
```

The scanner checks:
- Common folder names: code, projects, dev, Developer, repos, src, workspace, work, Sites, source
- Windows-specific: source/repos, Documents/GitHub, Documents/Projects
- Falls back to depth-3 scan from HOME for any missed repos
- Returns: name, path, stack, description, days_since_commit, active (< 90 days)

**Present popup:**
```
Found {N} active projects and {M} inactive.

Active projects:
  • repo-name    (Next.js, Convex)   — 3 days ago
  • repo-name-2  (Python)            — 12 days ago
  ...

Add all active projects to your vault? [Yes / Let me pick]
```

If "Let me pick": show numbered list, user types numbers.

---

## Step 4: Web Research Sub-Agent

If company website was provided, launch a sub-agent:

```
Research the company at {website}. Extract:
1. What the company does (2-3 sentences)
2. Their target customer / ICP
3. Their main products or services
4. Top 5 competitors (search "{company name} alternatives" and "{company name} competitors")
5. Industry/vertical
6. Tech stack if detectable (check job postings)
7. Team size estimate if mentioned

Return as JSON: { description, icp, products, competitors: [{name, description}], industry, stack, team_size }
```

If LinkedIn/X handle provided, also fetch public profile data for CLAUDE.md context.

Store results for Steps 6 and 8.

---

## Step 5: Confirmation Popups

Show one at a time. Do not proceed past a No.

```
[popup 1] Install 5 Obsidian plugins?
  Dataview, Tasks, Templater, Calendar, Obsidian Git
  [Yes / No]

[popup 2] Initialize Git repository for your vault?
  [Yes / No]

[popup 3] Set up company knowledge base?  (skip if "personal")
  [{CompanyName} section in 2. Areas/Business/]
  [Yes / No]

[popup 4] {note_app} export found at {path}. Migrate to Inbox/?
  (shown only if a notes export was detected)
  [Yes / No]
```

---

## Step 6: Scaffold Vault Structure

Run the scaffolding script with collected data:

```bash
python3 {baseDir}/scripts/scaffold.py \
  --name "{name}" \
  --company "{company}" \
  --projects '{projects_json}' \
  --stack '{stack_json}' \
  --email "{email}" \
  --calendar "{calendar}" \
  --research '{research_json}' \
  --vault "{vault_path}"
```

Creates (never overwrites existing files):

### Always (PARA core)
```
Inbox/
1. Projects/
2. Areas/
  context/
    about-me.md          ← seeded with name
    about-business.md    ← seeded with company
    priorities.md
    voice.md
  connections.md         ← 7 Tier-1 domain registry
  TaskNotes/
  Sessions/
  Claude Memory/
  Product Manager/
    PRDs/  Roadmaps/  Research/  Launches/  Metrics/
3. Resources/Templates/
4. Archives/Projects/  Tasks/
Zettelkasten/
CLAUDE.md
```

### Per active project
```
1. Projects/{repo}.md
2. Areas/Product Manager/PRDs/{repo}-PRD.md
2. Areas/Business/{company}/Projects/{repo}/
  PRD/  Features/  Decisions/tech-stack.md
```

### Company section (if not personal)
```
2. Areas/Business/{company}/
  Org/Decisions/log.md   ← append-only, initialized with setup entry
  Org/Strategy/strategy.md
  Org/Competitors/*.md   ← one per competitor from web research
  Org/Pipeline/  Org/Risks/
  Teams/Engineering/  Marketing/  Sales/
  Clients/
  Research/industry-overview.md
  Transcripts/  Archive/
```

---

## Step 7: Install Obsidian Plugins

If user said Yes to popup 1:

```bash
python3 {baseDir}/scripts/install-obsidian-plugins.py --vault "{vault_path}"
```

**Correct plugin IDs** (must match manifest.json exactly):

| Plugin | ID | Key settings written to data.json |
|---|---|---|
| Dataview | `dataview` | inline queries, refresh enabled |
| Tasks | `obsidian-tasks-plugin` | auto-suggest, done date tracking |
| Templater | `templater-obsidian` | template folder → `3. Resources/Templates` |
| Calendar | `calendar` | week starts Monday |
| Obsidian Git | `obsidian-git` | auto-commit 10min, auto-push, auto-pull on boot |

**Restricted mode check:**
The script checks if community plugins are already active. If not, it shows:

```
⚠  Action required:
   Open Obsidian → Settings → Community plugins → "Turn on community plugins"
   Then press Enter to continue.
```

Wait for user confirmation before proceeding.

---

## Step 8: Apply brainy settings

Hooks are registered automatically by the plugin via `hooks/hooks.json` — no manual
hook installation needed. This step only handles settings that can't be expressed in
hooks.json.

Run detection silently:

```bash
python3 {baseDir}/scripts/settings-writer.py detect
```

**If `autoMemoryDirectory` is not set**, show the user:

```
One setting routes Claude Code's memory files to your vault so they persist across
all projects. Apply it now?

  autoMemoryDirectory → <vault>/2. Areas/Claude Memory
  [Yes / No]
```

If Yes:

```bash
python3 {baseDir}/scripts/settings-writer.py apply --yes
```

**Plan mode default** — from the same `detect` output, look at `default_mode`.
**If it is not already `plan`**, offer it as a *separate* choice (do not bundle
it with the memory consent above):

```
Brainy recommends Claude Code start every session in plan mode, so work is
reviewed before it runs. This changes `permissions.defaultMode` to "plan"
(currently <default_mode>). It's reversible any time via /plan or settings.
Apply it?
  [Yes / No]
```

If Yes (this is a distinct, explicit consent — bare `apply --yes` never
changes the permission mode):

```bash
python3 {baseDir}/scripts/settings-writer.py apply --yes --set-default-mode
```

**Status line** (if no statusline is currently configured in `~/.claude/settings.json`):

```
Add the brainy status line? It shows inbox count, active project, and git branch
in Claude Code's status bar.
  [Yes / No]
```

If Yes, add to `~/.claude/settings.json`:
```json
{ "statusline": "<pluginDir>/hooks/statusline.js" }
```

---

## Step 9: Initialize Tooling

```bash
# Git (vault)
git -C "{vault_path}" init
git -C "{vault_path}" add .gitignore
git -C "{vault_path}" commit -m "initial vault setup via second-brain plugin"

# Beads (issue tracker) — --shared-server + --external is the canonical pair
# (the shared Dolt server is a user-machine singleton, managed outside bd's
# per-project lifecycle). Omitting --external can cause init to try starting
# a second server on the bound port and fail.
cd "{vault_path}" && bd init --shared-server --external --skip-agents --skip-hooks --non-interactive

# QMD (search index — rebuild after scaffold)
node ${CLAUDE_PLUGIN_ROOT}/scripts/qmd-wrapper.mjs index
```

---

## Step 10: Migrate Notes (if Yes on popup 4)

### Apple Notes (Mac only)
```bash
python3 {baseDir}/scripts/migrate-apple-notes.py --out "{vault_path}/Inbox"
```

### Notion
```bash
python3 {baseDir}/scripts/migrate-notion.py --export "{export_path}" --out "{vault_path}/Inbox"
```

### OneNote (Windows)
```bash
python3 {baseDir}/scripts/migrate-onenote.py --export "{export_path}" --out "{vault_path}/Inbox"
```

---

## Step 11: Done

```
Setup complete.

  ✓ PARA vault structure created
  ✓ context/ files seeded (about-me, priorities, voice)
  ✓ connections.md — 7 Tier-1 domains registered
  ✓ {N} projects scaffolded
  ✓ Company section seeded with web research
  ✓ {M} Obsidian plugins installed
  ✓ Git initialized
  ✓ Beads initialized
  ✓ QMD indexed
  ✓ CLAUDE.md written

→ Restart Obsidian once to activate plugins.
→ Run /daily to open today's note.
→ Run /tasks to manage your tasks.
→ Run /recall yesterday to load prior session context.
→ Run /health to verify all connections are live.
```
