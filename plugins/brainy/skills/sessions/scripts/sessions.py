#!/usr/bin/env python3
"""
Sync Claude Code sessions to Obsidian markdown.
Preserves user notes and metadata on re-sync.
"""

import os
import sys
import json
import argparse
import re
from pathlib import Path
from datetime import datetime, date


PROJECTS_DIR = Path.home() / ".claude" / "projects"
CLAUDE_SETTINGS = Path.home() / ".claude" / "settings.json"

PRESERVED_FRONTMATTER = {"comments", "tags", "rating", "status", "related"}


def find_vault() -> Path | None:
    for candidate in [
        Path.home() / "Obsidian Vault",
        Path.home() / "vault",
        Path.home() / "Documents" / "Obsidian",
    ]:
        if (candidate / ".obsidian").is_dir():
            return candidate
    return None


def sessions_dir(vault: Path) -> Path:
    d = vault / "2. Areas" / "Sessions"
    d.mkdir(parents=True, exist_ok=True)
    return d


def parse_session_jsonl(jsonl_path: Path) -> dict:
    messages = []
    first_user = ""
    tool_names: set[str] = set()

    try:
        for line in jsonl_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            msg_type = entry.get("type", "")
            msg = entry.get("message", {})
            content = msg.get("content", "")

            if msg_type == "user" and not first_user:
                if isinstance(content, list):
                    for c in content:
                        if isinstance(c, dict) and c.get("type") == "text":
                            first_user = c.get("text", "")[:120].replace("\n", " ")
                            break
                else:
                    first_user = str(content)[:120].replace("\n", " ")

            if isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "tool_use":
                        tool_names.add(c.get("name", ""))

            messages.append({"type": msg_type, "content": content})
    except Exception:
        pass

    msg_count = sum(1 for m in messages if m["type"] in ("user", "assistant"))
    mtime = datetime.fromtimestamp(jsonl_path.stat().st_mtime)

    return {
        "session_id": jsonl_path.stem,
        "project": jsonl_path.parent.name,
        "date": mtime.date().isoformat(),
        "mtime": mtime.isoformat(),
        "msg_count": msg_count,
        "first_user": first_user,
        "tools": sorted(tool_names),
        "messages": messages,
    }


def load_existing_note(note_path: Path) -> dict:
    """Extract preserved fields from an existing session note."""
    preserved = {}
    if not note_path.exists():
        return preserved

    content = note_path.read_text(encoding="utf-8", errors="ignore")
    # Parse frontmatter
    m = re.match(r"^---\n(.*?)\n---\n", content, re.DOTALL)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                key, _, val = line.partition(":")
                key = key.strip()
                if key in PRESERVED_FRONTMATTER:
                    preserved[key] = val.strip()

    # Extract My Notes section
    notes_m = re.search(r"## My Notes\n(.*?)(?=\n## |\Z)", content, re.DOTALL)
    if notes_m:
        preserved["_my_notes"] = notes_m.group(1).strip()

    return preserved


def render_conversation(messages: list) -> str:
    lines = []
    for msg in messages:
        role = msg["type"]
        if role not in ("user", "assistant"):
            continue
        content = msg["content"]
        if isinstance(content, list):
            text_parts = [
                c.get("text", "") for c in content
                if isinstance(c, dict) and c.get("type") == "text"
            ]
            content = "\n".join(text_parts)
        content = str(content)[:500].replace("\n", " ")
        label = "**You:**" if role == "user" else "**Claude:**"
        lines.append(f"{label} {content}")
    return "\n\n".join(lines[:40])


def render_note(session: dict, existing: dict) -> str:
    session_id = session["session_id"]
    session_date = session["date"]
    project = session["project"]
    tools = ", ".join(session["tools"]) if session["tools"] else "none"
    msg_count = session["msg_count"]
    summary = session.get("first_user", "")[:200]

    status = existing.get("status", "active")
    tags = existing.get("tags", "[]")
    rating = existing.get("rating", "null")
    comments = existing.get("comments", "")
    my_notes = existing.get("_my_notes", "")

    comments_block = f"comments: |\n  {comments}" if comments else "comments: null"

    conversation = render_conversation(session["messages"])

    return f"""---
type: claude-session
date: {session_date}
session_id: {session_id}
project: {project}
summary: "{summary}"
tools: {json.dumps(session['tools'])}
messages: {msg_count}
last_activity: {session['mtime']}
status: {status}
tags: {tags}
rating: {rating}
{comments_block}
---

# Session — {session_date}

**Project:** {project}
**Messages:** {msg_count}
**Tools used:** {tools}

## Summary

{summary}

## My Notes

{my_notes}

## Conversation

{conversation}
"""


def get_note_path(vault: Path, session: dict) -> Path:
    slug = session["session_id"][:16]
    filename = f"{session['date']}-{slug}.md"
    return sessions_dir(vault) / filename


def cmd_sync(args, vault: Path):
    # Find current session JSONL
    # Heuristic: most recently modified JSONL in any project dir
    all_jsonl = sorted(
        PROJECTS_DIR.rglob("*.jsonl"),
        key=lambda f: f.stat().st_mtime,
        reverse=True
    )
    if not all_jsonl:
        print("No sessions found.", file=sys.stderr)
        sys.exit(1)

    jsonl = all_jsonl[0]
    session = parse_session_jsonl(jsonl)
    note_path = get_note_path(vault, session)
    existing = load_existing_note(note_path)
    note_path.write_text(render_note(session, existing), encoding="utf-8")
    print(f"Synced: {note_path.name}")


def cmd_export(args, vault: Path):
    today_only = getattr(args, "today", False)
    export_all = getattr(args, "all", False)
    specific = getattr(args, "file", None)

    today_str = date.today().isoformat()

    if specific:
        files = [Path(specific)]
    else:
        files = sorted(PROJECTS_DIR.rglob("*.jsonl"),
                       key=lambda f: f.stat().st_mtime, reverse=True)
        if today_only:
            files = [f for f in files
                     if date.fromtimestamp(f.stat().st_mtime).isoformat() == today_str]

    count = 0
    for jsonl in files:
        session = parse_session_jsonl(jsonl)
        if session["msg_count"] < 3:
            continue
        note_path = get_note_path(vault, session)
        existing = load_existing_note(note_path)
        note_path.write_text(render_note(session, existing), encoding="utf-8")
        count += 1
        print(f"  ✓ {note_path.name}")

    print(f"\nExported {count} session{'s' if count != 1 else ''}.")


def cmd_list(args, vault: Path):
    show_all = getattr(args, "all", False)
    sdir = sessions_dir(vault)
    notes = sorted(sdir.glob("*.md"), reverse=True)

    print(f"\nSessions in vault ({len(notes)} total)\n")
    for note in notes[:20]:
        content = note.read_text(encoding="utf-8", errors="ignore")
        status = "active"
        m = re.search(r"^status: (\w+)", content, re.MULTILINE)
        if m:
            status = m.group(1)
        if not show_all and status == "done":
            continue
        print(f"  [{status}]  {note.name}")


def cmd_note(args, vault: Path):
    """Add a timestamped comment to the current session note."""
    text = args.text
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")

    # Find most recent session note
    sdir = sessions_dir(vault)
    notes = sorted(sdir.glob("*.md"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not notes:
        print("No session notes found.", file=sys.stderr)
        sys.exit(1)

    note_path = notes[0]
    content = note_path.read_text(encoding="utf-8")

    comment_line = f"[{ts}] {text}"
    if "comments: null" in content:
        content = content.replace("comments: null", f"comments: |\n  {comment_line}")
    elif "comments: |" in content:
        content = content.replace("comments: |", f"comments: |\n  {comment_line}\n ")

    note_path.write_text(content, encoding="utf-8")
    print(f"Note added to {note_path.name}")


def cmd_close(args, vault: Path):
    text = getattr(args, "text", "")
    sdir = sessions_dir(vault)
    notes = sorted(sdir.glob("*.md"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not notes:
        print("No session notes found.", file=sys.stderr)
        sys.exit(1)

    note_path = notes[0]
    content = note_path.read_text(encoding="utf-8")
    content = re.sub(r"^status: \w+", "status: done", content, flags=re.MULTILINE)

    if text:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M")
        comment_line = f"[{ts}] CLOSED: {text}"
        if "comments: null" in content:
            content = content.replace("comments: null", f"comments: |\n  {comment_line}")
        elif "comments: |" in content:
            content = content.replace("comments: |", f"comments: |\n  {comment_line}\n ")

    note_path.write_text(content, encoding="utf-8")
    print(f"Session closed: {note_path.name}")


def main():
    parser = argparse.ArgumentParser(description="Claude Code session sync")
    parser.add_argument("--vault", help="Vault path (auto-detected if omitted)")
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("sync")

    p_export = sub.add_parser("export")
    p_export.add_argument("--today", action="store_true")
    p_export.add_argument("--all", action="store_true")
    p_export.add_argument("file", nargs="?")

    p_list = sub.add_parser("list")
    p_list.add_argument("--all", action="store_true")

    p_resume = sub.add_parser("resume")
    p_resume.add_argument("--pick", action="store_true")

    p_note = sub.add_parser("note")
    p_note.add_argument("text")

    p_close = sub.add_parser("close")
    p_close.add_argument("text", nargs="?", default="")

    args = parser.parse_args()

    vault_path = Path(args.vault).expanduser() if getattr(args, "vault", None) else find_vault()
    if not vault_path:
        print("Obsidian vault not found. Use --vault to specify path.", file=sys.stderr)
        sys.exit(1)

    if args.cmd == "sync":
        cmd_sync(args, vault_path)
    elif args.cmd == "export":
        cmd_export(args, vault_path)
    elif args.cmd == "list":
        cmd_list(args, vault_path)
    elif args.cmd == "note":
        cmd_note(args, vault_path)
    elif args.cmd == "close":
        cmd_close(args, vault_path)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
