# braynee on Codex CLI: pinned contract and capability map

Pinned against **codex-cli 0.172.0** (`npm i -g @openai/codex`) and
openai/codex source at **372947d**, checked 2026-11-27 (cp-5ox, cp-sgp).
Everything marked *verified* was run against that binary in an isolated
`CODEX_HOME`; the rest cites source as `codex-rs/<path>:<line>`.

Codex ships fast. Before relying on this page, run `codex --version`; if it is
newer, re-run the checks in [Re-verifying](#re-verifying).

## Install

```text
codex plugin marketplace add <path to braynee checkout | owner/braynee>
codex plugin add braynee@braynee
```

- Codex reads braynee's **existing Claude Code marketplace**:
  `.claude-plugin/marketplace.json` is the third path it tries, after
  `.agents/plugins/marketplace.json` (`core-plugins/src/marketplace.rs:20-25`).
  *Verified*: the marketplace lists braynee, toolkit and foundation-first.
- The plugin manifest is `.codex-plugin/plugin.json`, falling back to
  `.claude-plugin/plugin.json`. braynee ships a generated
  `.codex-plugin/plugin.json` so it can point Codex at the right hooks file.
- Installed plugins are copied to `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>`
  and recorded in `$CODEX_HOME/config.toml` under `[plugins."braynee@braynee"]`.
- `codex mcp-server` **does not exist** in 0.172. `codex mcp` only manages
  external MCP servers.

## Hooks need approval once

Codex does not run a plugin's hooks until the user approves them. Each hook is
listed as `untrusted` until then (*verified* through the app-server's
`hooks/list`). Approval is stored per hook in `$CODEX_HOME/config.toml`:

```toml
[hooks.state."braynee@braynee:hooks/codex-hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:<declaration hash>"
trusted_content_hash = "sha256:<plugin content hash>"
```

The content hash covers the whole plugin, so **every braynee upgrade puts all
hooks back to `modified`** and they need approving again. Review them in
Codex's hooks UI after install and after each upgrade. braynee does not write
these entries for you: approving hooks is Codex's own safety check.

## Why Codex gets its own hooks file

Codex reads `hooks/hooks.json` by default, but it runs each handler as
`sh -lc "<command>"` (`cmd /C` on Windows) and has **no `args` field**
(`hooks/src/engine/command_runner.rs:450-470`). braynee's hooks use the
Claude Code exec form `{"command": "node", "args": [script]}`, so on Codex every
one ran a bare `node`, which read the hook payload from stdin as a script and
exited 1. *Verified*: all 48 handlers exited 1 that way.

`scripts/gen-codex-plugin.mjs` builds `hooks/codex-hooks.json` from
`hooks/hooks.json`:

- `node "${PLUGIN_ROOT}/hooks/x.js"` as one string. Codex substitutes
  `${PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` before the shell runs, and also
  exports both as env vars (`hooks/src/engine/discovery.rs:313-322`).
- Only events Codex has. The rest are dropped rather than faked.
- `matcher`, `timeout` (seconds, as in Claude Code) and `statusMessage` are kept.

The self-test fails if either generated file drifts from its source. After
changing `hooks/hooks.json` or `.claude-plugin/plugin.json`, run
`node scripts/gen-codex-plugin.mjs`.

*Verified* with the generated file: 48 of 56 handlers load, with no errors and
one warning (SessionEnd timeouts are clamped to 3s). Every handler then ran
against Codex-shaped payloads in a scratch git and beads repo. None crashed.
Every JSON output passed Codex's strict output schemas
(`hooks/schema/generated/*.output.schema.json`), and the guards blocked with
exit 2. All 21 skills appear in `codex debug prompt-input`.

## Hook contract (Codex vs Claude Code)

| | Codex 0.172 | Claude Code |
|---|---|---|
| Events | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, PostCompact, Stop, SubagentStart, SubagentStop, PermissionRequest, Interrupt, SessionEnd (`hooks/src/schema.rs:103`) | all of those plus Notification, TaskCreated/Completed, ConfigChange, CwdChanged, FileChanged, DirectoryAdded, StopFailure |
| Unknown event in hooks.json | skipped silently | n/a |
| Shell tool name | `Bash`; matcher `Bash\|PowerShell` still matches | `Bash` |
| File edits | one `apply_patch` tool, matchable as `apply_patch`, `Write` or `Edit`; `tool_input` is `{command: <patch text>}`, with **no `file_path`** (`hooks/src/events/pre_tool_use.rs:177`) | `Write` / `Edit` with `file_path` |
| Block | exit 2 (`pre_tool_use.rs:268`) or `decision: "block"` | same |
| JSON output | strict: an unknown field fails the hook and drops its context | lenient |
| Plain stdout | becomes model context on SessionStart / UserPromptSubmit (`events/session_start.rs:305`) | same |
| `updatedInput` | supported on PreToolUse | supported |
| Timeout unit | seconds; SessionEnd capped at 3s | seconds |
| `CLAUDE_ENV_FILE` | not provided | provided to SessionStart |
| `if` field | not supported | unreliable (braynee never uses it) |

## Capability map

| braynee behaviour | On Codex | Notes |
|---|---|---|
| Skills (`skills/*/SKILL.md`) | **Full** | read in place, listed as `braynee:<skill>` |
| Push-to-main guard, beads claim/close gates, commit-format check | **Full** | PreToolUse on `Bash`, exit 2 |
| bd actor signing (`beads-actor-sign`) | **Full** | via `updatedInput` |
| Session-start context (work surface, beads init, Obsidian) | **Full** | plain stdout becomes context |
| Memory reminder, beads todo reminder | **Full** | |
| Pre/PostCompact reinjection | **Full** | Codex has both events |
| Stop checks | **Full** | |
| `Executed-By:` commit trailer | **Degraded** | needs `BD_ACTOR` in the shell; Codex has no `CLAUDE_ENV_FILE`, so `beads-commit-actor` skips. Export `BD_ACTOR=codex` yourself |
| Hooks keyed on Write/Edit `file_path` (vault writes, secret scan on files) | **Degraded** | `apply_patch` gives patch text, not a path. These hooks see no path and stay silent |
| Agents (`agents/*.md`) | **None** | the Codex plugin manifest has no agents field; use the skills, or the playbook text directly |
| Slash commands (`commands/`) | **None** | not imported from a local marketplace |
| Statusline | **None** | |
| TaskCreated/TaskCompleted, Notification, FileChanged, CwdChanged, ConfigChange, DirectoryAdded, StopFailure hooks | **None** | no Codex event |
| Instructions file | Codex reads `AGENTS.override.md`, then `AGENTS.md`, from the project root down to the cwd, plus `~/.codex/AGENTS.md`. Extra names via `project_doc_fallback_filenames`; size capped by `project_doc_max_bytes`; skipped in untrusted projects (`core/src/agents_md.rs:44-51,375`) | Claude Code reads `CLAUDE.md` |

## Re-verifying

```bash
export CODEX_HOME=$(mktemp -d)
codex plugin marketplace add "$PWD" && codex plugin add braynee@braynee
codex debug prompt-input hi | grep -o 'braynee:[a-z0-9-]*' | sort -u   # skills
# hooks: JSON-RPC `hooks/list` on `codex app-server` (initialize first):
#   every braynee hook should be listed, with no errors in the result.
```

Not verified here: a live model turn (no OpenAI credential in the test
environment), and Codex's hooks-approval UI itself. The approval format above
was checked by writing it by hand and seeing `hooks/list` report `trusted`.
