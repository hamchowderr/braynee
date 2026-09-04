---
name: obsidian-cli
description: Interact with Obsidian vaults using the Obsidian CLI to read, create, search, and manage notes, tasks, properties, and more. Also supports plugin and theme development with commands to reload plugins, run JavaScript, capture errors, take screenshots, and inspect the DOM. Use when the user asks to interact with their Obsidian vault, manage notes, search vault content, perform vault operations from the command line, or develop and debug Obsidian plugins and themes.
---

# Obsidian CLI

Use the `obsidian` CLI to interact with a running Obsidian instance. Requires Obsidian to be open.

## Command reference

Run `obsidian help` to see all available commands. This is always up to date. Full docs: https://help.obsidian.md/cli

## Syntax

**Parameters** take a value with `=`. Quote values with spaces:

```bash
obsidian create name="My Note" content="Hello world"
```

**Flags** are boolean switches with no value:

```bash
obsidian create name="My Note" silent overwrite
```

For multiline content use `\n` for newline and `\t` for tab.

## File targeting

Many commands accept `file` or `path` to target a file. Without either, the active file is used.

- `file=<name>` — resolves like a wikilink (name only, no path or extension needed)
- `path=<path>` — exact path from vault root, e.g. `folder/note.md`

**Always prefer `path=` over `file=`** — it is unambiguous and doesn't depend on vault index state.

## Vault targeting

Commands target the most recently focused vault by default. Use `vault=<name>` as the first parameter to target a specific vault:

```bash
obsidian vault="My Vault" search query="test"
```

---

## CRITICAL: the 4000-byte cliff

**The total command line must stay under 4000 bytes.** At 4001+ the CLI fails **silently and completely**:

- exit code **0**
- no stdout, no stderr
- **zero bytes written**
- and the IPC socket then dies, so every later CLI call hangs or returns `unable to find Obsidian`

The budget covers the whole command — command name, `path=`, flags **and** `content=`. Verified by binary search on Obsidian 1.13.7: 4000 bytes writes, 4001 does not; and content that wrote fine at a short path failed when only the path grew by 62 bytes.

**Root cause:** the CLI's IPC layer calls `JSON.parse` on socket data without reassembling messages, so a payload split across pipe frames parses as a truncated fragment and throws. Upstream bug [forum 117325](https://forum.obsidian.md/t/cli-create-with-content-over-4-kb-crashes-the-main-process-with-a-json-parse-error/117325), filed Aug 2026, **open and unfixed as of 1.14.0**. There is **no stdin, no `-F`, and no `content=@file`** on any command — the [stdin request](https://forum.obsidian.md/t/support-stdin-pipe-for-obsidian-cli/112855) has had no staff response.

**Content SHAPE does not matter.** Colons, `[[wikilinks]]`, `[md](links)`, `- [ ]` checkboxes, em-dashes, curly quotes and full YAML frontmatter all write correctly. *(An earlier version of this skill claimed a `word:colon` / `[...]` parser bug causing exit 127. That was tested and is **false** — the real axis is size, not shape.)*

---

## Two-path decision — split on SIZE

### Path A — total command line comfortably under 4000 bytes

Any characters are fine. Budget ~3500 bytes for content to leave room for the path and flags.

```bash
obsidian create path="Folder/Note.md" content="# Title\nParagraph text" silent
obsidian create path="Folder/Note.md" content="# Updated\nNew content" silent overwrite
obsidian append path="Folder/Note.md" content="\n## New Section\nMore content"
```

### Path B — anything larger, or any content of unknown size ⭐ default

**Never inline a real note into the command.** Stage it as a file and have the eval read it — the eval argument then stays a fixed ~200 characters no matter how big the note is.

```bash
# 1. Write the content with the Write tool (zero shell escaping), then stage it INSIDE the vault
cp "/path/to/scratch/note.md" "$VAULT/_tmp.md"

# 2. Read by VAULT-RELATIVE path (keeps `C:/` out of the argument) and write via the Vault API
Obsidian.com eval code="(function(){ var t='Folder/Note.md'; app.vault.adapter.read('_tmp.md').then(function(c){ app.vault.create(t, c); }); return 'started'; })()"
# => started    (returns immediately; the write lands a moment later)

# 3. Clean up, then VERIFY BY CONTENT — not by exit code, not by byte count
rm -f "$VAULT/_tmp.md"
node -e "console.log(require('fs').readFileSync('<target>','utf8').includes('MARKER'))"
```

Swap `app.vault.create(t, c)` for `app.vault.modify(app.vault.getFileByPath(t), c)` to overwrite, or `app.vault.append(app.vault.getFileByPath(t), c)` to append.

Verified writing **17,000 bytes** this way at a size where `create content=` fails silently.

### Three rules for every `eval` body

1. **No `await`, ever.** `(async () => { … await … })()` **hangs the CLI** — it waits on the promise and never resolves. Start the work, return a plain string synchronously.
2. **At most one `.then`.** A nested `.then` silently no-ops: returns `started`, writes nothing. If you think you need two, use the API that collapses them — `app.vault.append(file, data)` does read-modify-write internally.
3. **Keep the argument ASCII.** Non-ASCII inline in the eval argument fails silently. Unicode inside the staged *content file* is fine.

---

## Exit codes are unreliable in both directions

| Observed | Meaning |
|---|---|
| exit 0, `Error:` on stdout | ordinary failure — file not found, unknown command |
| **exit 0, no output at all** | **silent total failure** — the >4000-byte cliff |
| exit 1, no output | the write may have **landed** |
| exit 1, `unable to find Obsidian` | IPC socket is dead |
| exit 124 under `timeout` | hung — socket wedged |

**Verify actual state on disk. Never trust `$?` or output alone**, and never retry a non-idempotent mutation on the strength of an exit code.

## Recovery when the CLI is wedged

1. Check for an Obsidian window titled **`Error`** — dismiss it; the CLI recovers immediately.
2. No dialog but still `unable to find Obsidian` — toggle Settings → General → **Command line interface** off and on.
3. Last resort: restart Obsidian. **Ask the user first.**

Diagnose in order: `eval code="1+1"` → a **sync** call like `app.vault.getFileByPath('…').path` → then the write.

---

## Always use these flags for non-interactive operations

```bash
obsidian create path="..." content="..." silent          # don't open the file
obsidian create path="..." content="..." silent overwrite # idempotent upsert
```

---

## Common patterns

```bash
# Read
obsidian read path="Folder/Note.md"

# Search
obsidian search query="search term" limit=10
obsidian search:context query="term" format=json

# Properties
obsidian property:set name="status" value="done" path="Folder/Note.md"
obsidian property:read name="type" path="Folder/Note.md"

# Daily note
obsidian daily:read
obsidian daily:append content="- [ ] New task"

# Tasks
obsidian tasks daily todo
obsidian tasks path="Folder" todo format=json

# Tags
obsidian tags sort=count counts

# Backlinks
obsidian backlinks path="Folder/Note.md"

# List files
obsidian files folder="1. Projects"
```

Use `--copy` on any command to copy output to clipboard. Use `total` on list commands to get a count.

---

## Plugin development

Reload a plugin after code changes:

```bash
obsidian plugin:reload id=my-plugin
```

Run JavaScript in the app context:

```bash
obsidian eval code="app.vault.getFiles().length"
```

Check for errors and console output:

```bash
obsidian dev:errors
obsidian dev:console
obsidian dev:console level=error
```

Take a screenshot for visual testing:

```bash
obsidian dev:screenshot path=screenshot.png
```

Inspect DOM and CSS:

```bash
obsidian dev:dom selector=".workspace-leaf" text
obsidian dev:css selector=".workspace-leaf" prop=background-color
```

Run `obsidian help` to see additional developer commands including CDP and debugger controls.
