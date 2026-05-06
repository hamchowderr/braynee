# brainy

**Claude Code's second brain** — turns your Claude Code sessions into a living, searchable knowledge system backed by an Obsidian vault.

Brainy is a Claude Code plugin that scaffolds a PARA vault, wires up your company knowledge base, detects your environment, installs the right Obsidian plugins, and keeps everything in sync session to session.

---

## What it sets up

### Company / Business knowledge base
Brainy creates an org-aware vault structure under `2. Areas/Business/`. Each business gets a folder with:
- `Clients/` — per-client notes, engagement logs, call prep
- `Org/` — Decisions, Strategy, Competitors, Pipeline, Risks
- `Operations/` — Consulting, Education, Marketing, Fulfillment
- `Shipped/` — live products still being maintained

You provide your company name and email domain during setup; brainy seeds the structure and names everything correctly from the start.

### Email detection
Brainy auto-detects your installed mail client:
- ProtonMail (Bridge or app)
- Gmail (browser profile or native app)
- Apple Mail (macOS)
- Outlook

Email context is stored in your knowledge base and surfaced during daily planning and client call prep.

### Calendar detection
Brainy detects your calendar platform and wires it into daily notes:
- Google Calendar
- Apple Calendar (macOS)
- Outlook Calendar

### Projects / git repo scanning
`scan-projects.py` walks your `~/code/` directory, finds git repos, detects the stack (Next.js, Convex, FastAPI, etc.), and writes a project map. The wizard surfaces these to Claude so it knows what you're building without you having to explain it.

### Claude Code hooks
Three hooks are installed into `~/.claude/settings.json` — no manual editing required:

| Hook | Event | What it does |
|------|-------|-------------|
| `vault-context.js` | SessionStart | Reads your vault `CLAUDE.md` and injects it as session context so Claude knows your businesses, clients, and conventions in every session |
| `session-tracker.js` | Stop | Writes a timestamped entry to `2. Areas/Sessions/` when each session ends |
| `qmd-sync.js` | Stop | Re-indexes your vault's QMD BM25 search index detached — vault search stays fresh after every session |

All three hooks detect existing equivalents and never duplicate them.

### Obsidian plugins
`install-obsidian-plugins.py` installs and configures the following plugins into your vault:
- **Dataview** — query your vault like a database
- **Tasks** — structured task management with due dates and filters
- **Templater** — powerful templating for notes and daily pages
- **Calendar** — daily note calendar navigation
- **Git** — vault backup and version history

### PARA vault structure
The full PARA scaffold:
```
Inbox/               → captures and incubating ideas
1. Projects/         → active codebases (one file per project)
2. Areas/            → ongoing responsibilities
3. Resources/        → reference material and templates
4. Archives/         → completed and retired work
Zettelkasten/        → atomic permanent notes
```

---

## Skills

| Skill | Command | What it does |
|-------|---------|-------------|
| `setup` | `/setup` | Onboarding wizard — runs the full install or audits an existing vault and shows only what's missing |
| `daily` | `/daily` | Open today's note, log what you're working on, and run an EOD summary |
| `recall` | `/recall` | Load context from previous sessions — temporal, topic (QMD BM25 + semantic), and graph modes |
| `query` | `/query` | Search the vault — keyword (BM25), semantic, and deep research modes |
| `sessions` | `/sessions` | Export Claude Code sessions to Obsidian markdown, list, and annotate |
| `tasks` | `/tasks` | Create, complete, and query tasks via Obsidian TaskNotes |
| `clients` | `/clients` | Client relationship management — context, engagement logs, call prep |
| `granola` | `/granola` | Sync Granola meeting notes to vault transcripts |
| `wispr` | `/wispr` | Voice dictation history, stats, and search via Wispr Flow local SQLite |
| `health` | `/health` | System health check — Four Cs audit (Context, Connections, Capabilities, Cadence) |
| `zettelkasten` | `/zettelkasten` | Create, find, and link atomic notes — permanent knowledge distillation |

---

## Quick install

```bash
# From the Claude Code marketplace
/plugin install brainy

# Or locally
cd second-brain
/plugin install .
```

After installing, run `/setup` to launch the wizard.

---

## Existing vault?

If you already have an Obsidian vault, `/setup` detects it and runs a non-destructive audit. It shows only what's missing — no duplicate folders created, no existing notes overwritten, no hooks added if you already have equivalent ones.

---

## Search

Brainy installs QMD (a local BM25 + semantic search engine) and keeps its index updated via the `qmd-sync.js` Stop hook. All brainy skills use QMD for vault search — never grep or filesystem scanning.

```bash
node ~/.claude/scripts/qmd-wrapper.mjs search "query"    # exact terms
node ~/.claude/scripts/qmd-wrapper.mjs vsearch "query"   # semantic
node ~/.claude/scripts/qmd-wrapper.mjs query "query"     # deep research
```

---

## Requirements

- Claude Code CLI
- Node.js 18+
- Python 3.10+
- Obsidian (must be running for vault write operations)
- Git

---

## Plugin name

`brainy` — published under the `otaku-solutions` namespace.
