---
name: setup
description: >
  Second brain onboarding wizard. Scaffolds PARA vault structure, company knowledge base,
  detects git projects from the filesystem, seeds company notes from the web, installs
  Obsidian plugins, initializes Git/Beads/QMD, and writes CLAUDE.md.
  Use when user says "setup", "set up my vault", "onboard", "initialize second brain",
  "run setup", or installs this plugin for the first time.
argument-hint: [--reset | --company-only | --projects-only]
allowed-tools: Bash(*), Write(*), Read(*), WebFetch(*), Agent(*)
disable-model-invocation: true
---

# Setup Skill

Onboarding wizard that turns an empty machine into a fully wired second brain.
User types 4 things. Everything else is auto-detected, researched, or confirmed with a Yes/No popup.

## What It Does

1. Collects 4 inputs: name, company, website, social handle
2. Scans filesystem for git repos (all folder names, not just ~/code)
3. Runs web research sub-agent to seed company knowledge
4. Scaffolds PARA vault + company structure + PRD section + Development section
5. Installs Obsidian community plugins
6. Initializes Git, Beads, QMD
7. Migrates notes from detected source apps (Apple Notes, Notion, OneNote)
8. Writes CLAUDE.md seeded with user context

## Workflow

See `workflows/setup.md` for the full step-by-step process.

## Usage

```
/setup
/setup --reset          # Re-run, overwrite existing structure
/setup --company-only   # Only scaffold company section
/setup --projects-only  # Only scan and scaffold projects
```

## Inputs Collected

| # | Question | Used for |
|---|---|---|
| 1 | Your name | CLAUDE.md personalization |
| 2 | Company name (or "personal") | Business folder naming, web research |
| 3 | Company website URL | Research sub-agent seed |
| 4 | LinkedIn or Twitter/X handle (optional) | Personal CLAUDE.md context |

## Auto-Detected (No Questions)

- OS (Mac/Windows)
- Email platform (check installed apps / default mail handler)
- Existing note apps (Apple Notes, Notion, OneNote)
- Obsidian vault path (search for .obsidian folder)
- Git repos (deep scan, all folder names)
- Tech stack per repo (package.json, requirements.txt, etc.)
- Calendar platform (Apple Calendar, Google Calendar)

## Obsidian Plugins Installed

Plugin IDs must match the plugin's own `manifest.json` id exactly — this is also the
folder name under `.obsidian/plugins/` and the entry in `community-plugins.json`.

| Plugin | Correct ID | Key settings written |
|---|---|---|
| Dataview | `dataview` | inline queries, refresh enabled |
| Tasks | `obsidian-tasks-plugin` | auto-suggest, set done date |
| Templater | `templater-obsidian` | template folder → `3. Resources/Templates` |
| Calendar | `calendar` | week starts Monday |
| Obsidian Git | `obsidian-git` | auto-commit every 10min, auto-push, auto-pull on boot |

Per-plugin settings are written to `.obsidian/plugins/<id>/data.json`.
Existing `data.json` files are never overwritten (user customizations preserved).

### Restricted Mode — One-Time Manual Step

Community plugins require "restricted mode" to be OFF. This is stored inside Obsidian's
internal database (not in vault files), so it cannot be set programmatically.

The setup wizard checks if plugins are already active. If not, it shows a popup:

> **Action required:**
> Open Obsidian → Settings → Community plugins → click **"Turn on community plugins"**
> Then come back and press Yes to continue.

This is a one-time step per vault.

## Structure Built

```
<vault>/
├── 1. Projects/                    ← PARA personal/client projects
├── 2. Areas/
│   ├── Product Manager/
│   │   ├── PRDs/
│   │   ├── Roadmaps/
│   │   ├── Research/
│   │   ├── Launches/
│   │   └── Metrics/
│   ├── Development/                ← only frameworks detected in repos
│   ├── Business/
│   │   └── <CompanyName>/
│   │       ├── Org/
│   │       │   ├── Decisions/
│   │       │   ├── Strategy/      ← seeded from website
│   │       │   ├── Competitors/   ← seeded from web research
│   │       │   ├── Pipeline/
│   │       │   └── Risks/
│   │       ├── Teams/
│   │       │   ├── Engineering/
│   │       │   ├── Marketing/
│   │       │   └── Sales/
│   │       ├── Projects/
│   │       │   └── <repo>/
│   │       │       ├── PRD/
│   │       │       ├── Features/
│   │       │       └── Decisions/
│   │       ├── Research/
│   │       ├── Transcripts/
│   │       └── Archive/
│   ├── TaskNotes/
│   ├── Sessions/
│   └── Claude Memory/
├── 3. Resources/
├── 4. Archives/
├── Zettelkasten/
└── CLAUDE.md
```
