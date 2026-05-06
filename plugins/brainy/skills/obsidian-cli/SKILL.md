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

## CRITICAL: CLI content parsing bugs

The `obsidian` CLI argument parser has two known failure patterns that cause **silent exit code 127**:

1. **`word:anything`** — a colon immediately after a word with no preceding space. Triggers on YAML frontmatter (`type: note`), property-like content, markdown link labels.
2. **`[...]`** — square brackets anywhere in content. Triggers on YAML arrays (`tags: [a, b]`), markdown links, task checkboxes (`- [ ] task`).

**Rule:** Any note with YAML frontmatter, markdown links, task lists, or structured data will fail with `obsidian create` / `obsidian append`. Use the `eval` path instead.

---

## Two-path decision

### Path A — Simple content only (no frontmatter, no brackets, no `word:` patterns)

```bash
# Create new file
obsidian create path="Folder/Note.md" content="# Title\nParagraph text" silent

# Overwrite existing file
obsidian create path="Folder/Note.md" content="# Updated\nNew content" silent overwrite

# Append to file
obsidian append path="Folder/Note.md" content="\n## New Section\nMore content"
```

### Path B — Complex content (frontmatter, brackets, structured markdown)

Use `obsidian eval` with an async IIFE. This calls the Obsidian JavaScript API directly, bypassing the CLI parser entirely.

**Create a new file:**
```bash
obsidian eval code="(async () => { await app.vault.create('Folder/Note.md', '---\ntype: note\ntags:\n  - example\n---\n\n# Title\n\nContent here.\n'); })()"
```

**Overwrite an existing file:**
```bash
obsidian eval code="(async () => { const f = app.vault.getFileByPath('Folder/Note.md'); await app.vault.modify(f, '---\ntype: note\n---\n\n# Updated\n'); })()"
```

**Append to an existing file:**
```bash
obsidian eval code="(async () => { const f = app.vault.getFileByPath('Folder/Note.md'); const cur = await app.vault.read(f); await app.vault.modify(f, cur + '\n## Appended\n\nNew content.\n'); })()"
```

### Escaping inside `eval code="..."` (bash double-quoted string → JS single-quoted string)

| Character in content | Write as in the bash command |
|---|---|
| newline | `\n` |
| tab | `\t` |
| single quote `'` | `\'` |
| double quote `"` | `\"` |
| backslash `\` | `\\\\` |

Example — content with quotes and frontmatter:
```bash
obsidian eval code="(async () => { const f = app.vault.getFileByPath('Inbox/Note.md'); await app.vault.modify(f, '---\ntype: note\nstatus: active\ntags:\n  - example\n---\n\n# Title\n\nShe said \"hello\" and it\'s fine.\n'); })()"
```

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
