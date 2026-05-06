#!/usr/bin/env python3
"""
Zettelkasten — create, find, and review atomic notes.
Uses obsidian CLI for all vault writes.
"""

import os
import sys
import json
import argparse
import subprocess
from pathlib import Path
from datetime import datetime


def find_vault() -> Path | None:
    for candidate in [
        Path.home() / "Obsidian Vault",
        Path.home() / "vault",
        Path.home() / "Documents" / "Obsidian",
    ]:
        if (candidate / ".obsidian").is_dir():
            return candidate
    return None


def obsidian_eval(js_code: str) -> str:
    result = subprocess.run(
        ["obsidian", "eval", f"code={js_code}"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"obsidian eval failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()


def qmd_search(query: str) -> list[dict]:
    qmd = Path.home() / ".claude" / "scripts" / "qmd-wrapper.mjs"
    result = subprocess.run(
        ["node", str(qmd), "vsearch", query],
        capture_output=True, text=True
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def atom_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def atom_content(title: str, zettel_id: str) -> str:
    return f"""---
type: atom
id: {zettel_id}
tags: []
links: []
created: {datetime.now().date().isoformat()}
---

# {title}

One focused idea here.

## Links

## Source

"""


def cmd_new(args, vault: Path):
    title = args.title
    zettel_id = atom_id()
    rel_path = f"Zettelkasten/{zettel_id}.md"
    content = atom_content(title, zettel_id)

    escaped_content = content.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
    rel_escaped = rel_path.replace("'", "\\'")

    js = (
        f"(async () => {{"
        f"  const f = await app.vault.create('{rel_escaped}', '{escaped_content}');"
        f"  app.workspace.openLinkText('', '{rel_escaped}', false);"
        f"}})()"
    )
    obsidian_eval(js)
    print(f"Created: {rel_path}")
    print(f"Title: {title}")
    print(f"ID: {zettel_id}")


def cmd_find(args, vault: Path):
    query = args.query
    print(f"\nSearching Zettelkasten for: {query}\n")

    qmd = Path.home() / ".claude" / "scripts" / "qmd-wrapper.mjs"
    result = subprocess.run(
        ["node", str(qmd), "vsearch", query],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        print(result.stdout)
    else:
        print("No results.", file=sys.stderr)


def cmd_review(args, vault: Path):
    """List zettelkasten atoms with no outbound links."""
    zettel_dir = vault / "Zettelkasten"
    if not zettel_dir.exists():
        print("No Zettelkasten directory found.")
        return

    orphans = []
    for f in sorted(zettel_dir.glob("*.md")):
        content = f.read_text(encoding="utf-8", errors="ignore")
        # Has links section but it's empty
        has_link = "[[" in content
        if not has_link:
            title_match = next((l for l in content.splitlines() if l.startswith("# ")), "")
            title = title_match[2:].strip() if title_match else f.stem
            orphans.append((f.stem, title))

    if not orphans:
        print("All atoms have outbound links.")
        return

    print(f"\nAtoms with no links ({len(orphans)}):\n")
    for zettel_id, title in orphans:
        print(f"  {zettel_id}  {title}")


def cmd_inbox(args, vault: Path):
    """List Inbox items that could become atoms."""
    inbox = vault / "Inbox"
    if not inbox.exists():
        print("No Inbox directory.")
        return

    items = list(inbox.glob("*.md"))
    if not items:
        print("Inbox is empty.")
        return

    print(f"\nInbox — {len(items)} items to process\n")
    for item in sorted(items):
        print(f"  {item.name}")

    print(f"\nFor each: distill into one atomic note with /zettelkasten new")


def main():
    parser = argparse.ArgumentParser(description="Zettelkasten atomic notes")
    parser.add_argument("--vault", help="Vault path (auto-detected if omitted)")
    sub = parser.add_subparsers(dest="cmd")

    p_new = sub.add_parser("new")
    p_new.add_argument("title")

    p_find = sub.add_parser("find")
    p_find.add_argument("query")

    sub.add_parser("review")
    sub.add_parser("inbox")

    args = parser.parse_args()

    vault = Path(args.vault).expanduser() if getattr(args, "vault", None) else find_vault()
    if not vault:
        print("Vault not found. Use --vault to specify.", file=sys.stderr)
        sys.exit(1)

    if args.cmd == "new":
        cmd_new(args, vault)
    elif args.cmd == "find":
        cmd_find(args, vault)
    elif args.cmd == "review":
        cmd_review(args, vault)
    elif args.cmd == "inbox":
        cmd_inbox(args, vault)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
