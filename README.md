# claude-plugins

The **`hamch-plugins`** [Claude Code](https://code.claude.com/) plugin marketplace by [Otaku Solutions](https://otakusolutions.io). Currently ships one plugin — **Brainy** — with room for more.

## Install

```shell
claude plugin marketplace add hamchowderr/claude-plugins
claude plugin install brainy@hamch-plugins
```

Then restart Claude Code.

## Plugins

### Brainy

Turns Claude Code into your **second brain** — a PARA-structured Obsidian vault, company knowledge base, project & session tracking, persistent memory across sessions, all-time usage insights (`/brainy:insightful`), and daily workflow skills, kept in sync session to session.

- **Install:** `claude plugin install brainy@hamch-plugins`
- **Without a marketplace** (Claude Code ≥ v2.1.128):
  ```shell
  claude --plugin-url https://github.com/hamchowderr/claude-plugins/releases/download/brainy--v<version>/brainy.zip
  ```
  Each [release](https://github.com/hamchowderr/claude-plugins/releases) ships a `brainy.zip` asset; pin the tag to the version you want.
- **Requires** Claude Code ≥ 2.1.85.
- **Full docs:** [`plugins/brainy/README.md`](plugins/brainy/README.md)

## License

MIT
