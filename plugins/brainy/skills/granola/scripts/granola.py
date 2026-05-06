#!/usr/bin/env python3
"""
Granola meeting notes — list, get, and sync to Obsidian.
Reads from local cache. No API needed.
"""

import os
import sys
import json
import argparse
import platform
from pathlib import Path
from datetime import datetime


def cache_path() -> Path:
    system = platform.system()
    if system == "Darwin":
        return Path.home() / "Library/Application Support/Granola/cache-v3.json"
    else:
        raise RuntimeError("Granola is only available on macOS")


def load_cache() -> dict:
    path = cache_path()
    if not path.exists():
        print(f"Granola cache not found at: {path}", file=sys.stderr)
        print("Make sure Granola is installed and has recorded at least one meeting.", file=sys.stderr)
        sys.exit(1)
    raw = json.loads(path.read_text(encoding="utf-8"))
    # Cache is a JSON string inside a JSON object
    state = raw.get("cache") or raw
    if isinstance(state, str):
        state = json.loads(state)
    return state.get("state", state)


def get_documents(state: dict) -> dict:
    return state.get("documents", {})


def get_transcripts(state: dict) -> dict:
    return state.get("transcripts", {})


def load_synced(vault: Path) -> set[str]:
    """Return set of already-synced granola IDs from vault."""
    synced = set()
    transcripts_dir = vault / "2. Areas"
    for f in transcripts_dir.rglob("*.md"):
        try:
            content = f.read_text(encoding="utf-8", errors="ignore")
            for line in content.splitlines():
                if line.startswith("granola_id:"):
                    gid = line.split(":", 1)[1].strip()
                    synced.add(gid)
                    break
        except Exception:
            pass
    return synced


def format_duration(docs: dict, doc_id: str, transcripts: dict) -> int:
    segments = transcripts.get(doc_id, [])
    if not segments:
        return 0
    try:
        first = segments[0].get("start_timestamp", "")
        last = segments[-1].get("end_timestamp", "")
        if first and last:
            t1 = datetime.fromisoformat(first.rstrip("Z"))
            t2 = datetime.fromisoformat(last.rstrip("Z"))
            return int((t2 - t1).total_seconds() / 60)
    except Exception:
        pass
    return 0


def format_transcript(segments: list) -> str:
    lines = []
    for seg in segments:
        ts = seg.get("start_timestamp", "")[:19].replace("T", " ")
        source = seg.get("source", "")
        icon = "🎤" if source == "microphone" else "🔊"
        text = seg.get("text", "").strip()
        if text:
            lines.append(f"[{ts}] {icon} {text}")
    return "\n".join(lines)


def meeting_note(doc_id: str, doc: dict, segments: list, synced: set) -> str:
    title = doc.get("title", "Untitled Meeting")
    created = doc.get("created_at", "")[:10]
    notes_md = doc.get("notes_markdown", "") or doc.get("notes_plain", "") or ""
    people = doc.get("people", [])

    people_yaml = ""
    if people:
        people_yaml = "people:\n" + "\n".join(f'  - "[[{p}]]"' for p in people) + "\n"

    duration = 0
    if segments:
        try:
            t1 = datetime.fromisoformat(segments[0]["start_timestamp"].rstrip("Z"))
            t2 = datetime.fromisoformat(segments[-1]["end_timestamp"].rstrip("Z"))
            duration = int((t2 - t1).total_seconds() / 60)
        except Exception:
            pass

    transcript_text = format_transcript(segments)

    return f"""---
type: meeting
date: {created}
duration_min: {duration}
granola_id: {doc_id}
{people_yaml}status: raw
---

# {title}

## Notes

{notes_md}

## Transcript

{transcript_text}
"""


def find_vault() -> Path | None:
    for candidate in [
        Path.home() / "Obsidian Vault",
        Path.home() / "vault",
        Path.home() / "Documents" / "Obsidian",
    ]:
        if (candidate / ".obsidian").is_dir():
            return candidate
    return None


def cmd_list(args, state: dict):
    docs = get_documents(state)
    transcripts = get_transcripts(state)

    vault = find_vault()
    synced = load_synced(vault) if vault else set()

    limit = getattr(args, "limit", None)
    items = sorted(docs.items(), key=lambda x: x[1].get("created_at", ""), reverse=True)
    if limit:
        items = items[:limit]

    print(f"\n{len(docs)} meetings total\n")
    for doc_id, doc in items:
        marker = "[✓]" if doc_id in synced else "[ ]"
        title = doc.get("title", "Untitled")
        created = doc.get("created_at", "")[:10]
        seg_count = len(transcripts.get(doc_id, []))
        duration = format_duration(docs, doc_id, transcripts)
        print(f"  {marker} {created}  {title}")
        print(f"       ID: {doc_id[:16]}...")
        if seg_count:
            print(f"       Transcript: {seg_count} segments, ~{duration} min")
        print()


def cmd_get(args, state: dict):
    docs = get_documents(state)
    transcripts = get_transcripts(state)
    doc_id = args.id

    # Allow partial ID match
    match = next((k for k in docs if k.startswith(doc_id)), None)
    if not match:
        print(f"Meeting not found: {doc_id}", file=sys.stderr)
        sys.exit(1)

    doc = docs[match]
    segments = transcripts.get(match, [])

    print(f"\n{doc.get('title', 'Untitled')}")
    print(f"Date: {doc.get('created_at', '')[:10]}")
    print(f"People: {', '.join(doc.get('people', []))}")
    print()

    notes = doc.get("notes_markdown") or doc.get("notes_plain") or ""
    if notes:
        print("── Notes ──────────────────────────────")
        print(notes[:2000])
        print()

    if not getattr(args, "no_transcript", False) and segments:
        print("── Transcript ─────────────────────────")
        print(format_transcript(segments[:50]))
        if len(segments) > 50:
            print(f"  ... ({len(segments) - 50} more segments)")
    print()


def cmd_sync(args, state: dict):
    docs = get_documents(state)
    transcripts = get_transcripts(state)

    vault = find_vault()
    if not vault:
        print("Obsidian vault not found. Set --vault path.", file=sys.stderr)
        sys.exit(1)

    # Find transcripts dir — use company transcripts if available
    out_dir = vault / "2. Areas" / "Business"
    company_dirs = [d for d in out_dir.iterdir() if d.is_dir()] if out_dir.is_dir() else []
    if company_dirs:
        out_dir = company_dirs[0] / "Transcripts"
    else:
        out_dir = vault / "Inbox" / "Meetings"
    out_dir.mkdir(parents=True, exist_ok=True)

    synced = load_synced(vault)
    specific_id = getattr(args, "id", None)
    sync_all = getattr(args, "all", False)

    to_sync = {}
    if specific_id:
        match = next((k for k in docs if k.startswith(specific_id)), None)
        if match:
            to_sync[match] = docs[match]
    else:
        for doc_id, doc in docs.items():
            if sync_all or doc_id not in synced:
                to_sync[doc_id] = doc

    if not to_sync:
        print("Nothing new to sync.")
        return

    synced_count = 0
    for doc_id, doc in to_sync.items():
        title = doc.get("title", "Untitled").replace("/", "-").replace(":", "-")
        date = doc.get("created_at", "unknown")[:10]
        filename = f"{date} {title}.md"
        dest = out_dir / filename

        if dest.exists() and not sync_all:
            continue

        segments = transcripts.get(doc_id, [])
        content = meeting_note(doc_id, doc, segments, synced)
        dest.write_text(content, encoding="utf-8")
        synced_count += 1
        print(f"  ✓ {filename}")

    print(f"\nSynced {synced_count} meeting{'s' if synced_count != 1 else ''}.")


def main():
    parser = argparse.ArgumentParser(description="Granola meeting notes CLI")
    parser.add_argument("--vault", help="Path to Obsidian vault (auto-detected if omitted)")
    sub = parser.add_subparsers(dest="cmd")

    p_list = sub.add_parser("list")
    p_list.add_argument("--limit", type=int)

    p_get = sub.add_parser("get")
    p_get.add_argument("id")
    p_get.add_argument("--no-transcript", action="store_true")

    p_sync = sub.add_parser("sync")
    p_sync.add_argument("--id")
    p_sync.add_argument("--all", action="store_true")

    args = parser.parse_args()

    state = load_cache()

    if args.cmd == "list":
        cmd_list(args, state)
    elif args.cmd == "get":
        cmd_get(args, state)
    elif args.cmd == "sync":
        cmd_sync(args, state)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
