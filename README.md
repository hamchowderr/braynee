# claude-plugins

The **`hamch-plugins`** [Claude Code](https://code.claude.com/) marketplace by [Otaku Solutions](https://otakusolutions.io). Flagship plugin: **Brainy**.

---

## Brainy — Claude Code's second brain

Claude Code is brilliant and **amnesiac**. Close the terminal and yesterday's work, decisions, and context are gone — you re-explain the project every morning.

Brainy fixes that. It turns every Claude Code session into a living, searchable knowledge system backed by your own Obsidian vault, and keeps it in sync **automatically** — nothing to remember, it just happens while you work.

### Without Brainy → with Brainy

| | Without | With Brainy |
|---|---|---|
| **Context between sessions** | Re-explain the project every morning | Next session opens with your last note, branch, and where you left off |
| **Memory** | Claude relearns your prefs & decisions every time | A persistent `MEMORY.md` Claude is reminded to check *before* it guesses |
| **Session history** | Evaporates into a transcript you'll never read | Every session distilled into your vault — searchable forever (local BM25 + semantic) |
| **Tasks** | "Wait, what was I doing?" | beads ⇄ Claude todos ⇄ Obsidian TaskNotes, kept in sync — survives a context wipe |
| **Knowledge base** | Scattered across your head and chats | A scaffolded PARA vault: projects, clients, decisions, resources |
| **Guardrails** | Manual vigilance | Hooks block main-branch commits, enforce branch naming, nudge cadence — automatically |

### How it works

Brainy declares **lifecycle hooks across 10+ Claude Code events** in the plugin itself (nothing written to your global settings). They quietly do the work every session: launch Obsidian, open and maintain the session note, snapshot & restore context across compaction, keep memory indexed, mirror tasks three ways, protect `main`/`master`, and refresh a local search index — with zero ceremony.

On first run, `/setup` scaffolds a full **PARA Obsidian vault** (Projects / Areas / Resources / Archives + Zettelkasten + Inbox), a **company & client knowledge base**, detects your **email / calendar / git projects**, and installs the right Obsidian community plugins. It bundles skills for daily planning, cross-session recall, vault search, client prep, Zettelkasten, PRDs, and all-time usage insights (`/brainy:insightful`). Already have a vault? `/setup` runs a **non-destructive audit** and shows only what's missing.

### Install

**Marketplace (recommended):**

```bash
claude plugin marketplace add hamchowderr/claude-plugins
claude plugin install brainy@hamch-plugins
```

**Without a marketplace** (Claude Code ≥ v2.1.128):

```bash
claude --plugin-url https://github.com/hamchowderr/claude-plugins/releases/download/brainy--v<version>/brainy.zip
```

Each [GitHub release](https://github.com/hamchowderr/claude-plugins/releases) ships a `brainy.zip` asset — pin the tag to the version you want. After installing, run `/setup`.

### Requirements

Claude Code ≥ 2.1.85 · Node 18+ · Python 3.10+ · Obsidian (running for vault writes) · Git

### Full documentation

Every hook, every skill, the setup wizard, search, and development/testing live in **[`plugins/brainy/README.md`](plugins/brainy/README.md)**.

---

## License

MIT
