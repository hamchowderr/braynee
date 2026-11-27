# Installing braynee in Mastra Code

braynee runs in Claude Code and in [Mastra Code](https://code.mastra.ai/) from the
same checkout. This page is the Mastra Code half (cp-3o3g.5). Contract checked
against `@mastra/code-sdk` 1.21.0 and mastra `main` (2026-11-27):
`sdk/src/plugins/{install,loader,paths}.ts`, `sdk/src/hooks/{config,executor,types}.ts`.

## 1. Install the plugin

```text
mastracode
/plugins          -> Install new plugin
                  -> Local path:  <path to your braynee checkout>
                  -> or GitHub:   https://github.com/<owner>/braynee
```

- Point it at the **repo root**. `.mastracode-plugin.json` lives there, so the
  plugin root is the repo and Mastra Code finds `skills/` and `commands/` in
  place: no copies, no symlinks, no build step.
- A GitHub install clones through the `gh` CLI, so `gh` must be installed and
  signed in (`gh auth status`). Only `github.com` URLs are accepted.
- Installed plugins are recorded in `~/.mastracode/plugins/plugins.json` (user
  scope) or `<project>/.mastracode/plugins/plugins.json` (project scope); GitHub
  checkouts land under `.../plugins/sources/github/<owner>-<repo>`.

What you get from the plugin itself:

| Surface | Source | Notes |
|---|---|---|
| Skills | `<repo>/skills` | the same files Claude Code reads |
| `/braynee:<agent>` commands | `<repo>/commands/braynee` | each delegates to Mastra Code's built-in subagent tool; Mastra Code has no custom subagent types (cp-3o3g.4) |
| Instructions | `mastracode/src/index.ts` | the vault search mandate, byte-identical to the Claude Code hook's text, with absolute paths resolved at load time |

## 2. Add the hooks (by hand, once)

Plugins cannot contribute hooks in Mastra Code: hooks come only from
`~/.mastracode/hooks.json` (global) and `<project>/.mastracode/hooks.json`.
braynee's hooks read either host's payload (`hooks/lib/hook-payload.js`), so the
scripts are wired directly, with no translation shim.

Differences from Claude Code's `hooks.json` that matter when writing it:

- `timeout` is in **milliseconds** (default 10000), not seconds.
- `matcher.tool_name` is a **regex on Mastra Code's tool names**:
  `execute_command` (Bash), `view` (Read), `write_file` (Write),
  `string_replace_lsp` / `ast_smart_edit` (Edit), `find_files` (Glob),
  `search_content` (Grep).
- Blocking works only on `PreToolUse`, `UserPromptSubmit` and `Stop`, and only
  by exit code 2. braynee's guards already deny that way (self-test checks it).
- Hooks cannot add context to the model on this host (the TUI ignores
  `additionalContext`), which is why the plugin carries instructions instead.

The guards verified on Mastra Code (cp-3o3g.3) are a sensible starting set:

```json
{
  "PreToolUse": [
    { "type": "command", "command": "node /abs/path/braynee/hooks/vault-search-guard.js",
      "matcher": { "tool_name": "^(execute_command|find_files|search_content)$" }, "timeout": 5000 },
    { "type": "command", "command": "node /abs/path/braynee/hooks/check-no-main-push.js",
      "matcher": { "tool_name": "^execute_command$" }, "timeout": 5000 },
    { "type": "command", "command": "node /abs/path/braynee/hooks/secret-exposure-guard.js",
      "matcher": { "tool_name": "^(execute_command|write_file)$" }, "timeout": 5000 }
  ],
  "UserPromptSubmit": [
    { "type": "command", "command": "node /abs/path/braynee/hooks/memory-reminder.js", "timeout": 5000 }
  ]
}
```

**Windows paths.** Before `@mastra/code-sdk` 1.21.0 a quoted hook path could not
be expressed on Windows (mastra-ai/mastra#20681). 1.21.0 spawns `cmd` with
`windowsVerbatimArguments`, so `"node \"C:/Program Files/.../x.js\""` now works.
On an older SDK keep hook paths free of spaces.

## 3. Coexisting with the Claude Code install

Both hosts can be installed at once; neither changes the other's files.

- **Skills** are read from the same checkout by both hosts.
- **Global instructions:** Mastra Code reads `AGENTS.md` before `CLAUDE.md` at
  each location. A `~/.claude/AGENTS.md` therefore shadows `~/.claude/CLAUDE.md`
  in Mastra Code only. braynee no longer writes one (cp-3o3g.6); delete a stale
  copy if Mastra Code is missing your global rules.
- **Hooks** are separate files (`~/.claude/settings.json` plugin hooks vs
  `~/.mastracode/hooks.json`), so wiring one host never fires the other.
- **The Claude Code-only parts** (statusline, `SessionStart` context injection,
  PreCompact/PostCompact, TaskCreated/TaskCompleted) have no Mastra Code event
  or cannot inject context there; they simply don't run.

## 4. Check it

```text
/plugins            braynee is listed and enabled
/skills             braynee's skills are listed
/hooks              your hooks.json entries are listed
/braynee:vault-lint runs the agent through the built-in subagent tool
```

Then try a guarded command, for example `git push origin main` in a scratch
repo: Mastra Code should refuse it with the hook's message.
