#!/usr/bin/env python3
"""
Wispr Flow voice dictation history — stats, search, export, dashboard.
Reads from local SQLite DB. No API needed.
"""

import os
import sys
import json
import sqlite3
import argparse
import platform
from pathlib import Path
from datetime import datetime, date, timedelta, timezone


def db_path() -> Path:
    system = platform.system()
    if system == "Darwin":
        return Path.home() / "Library/Application Support/Wispr Flow/flow.sqlite"
    elif system == "Windows":
        appdata = os.environ.get("APPDATA", "")
        return Path(appdata) / "Wispr Flow/flow.sqlite"
    else:
        raise RuntimeError(f"Unsupported OS: {system}")


def get_conn() -> sqlite3.Connection:
    path = db_path()
    if not path.exists():
        print(f"Wispr Flow database not found at: {path}", file=sys.stderr)
        print("Make sure Wispr Flow is installed and has been used at least once.", file=sys.stderr)
        sys.exit(1)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    return conn


def period_filter(period: str) -> tuple[str, list]:
    today = date.today().isoformat()
    if period == "today":
        return "WHERE date(timestamp) = date('now')", []
    elif period == "yesterday":
        return "WHERE date(timestamp) = date('now', '-1 day')", []
    elif period == "week":
        return "WHERE date(timestamp) >= date('now', '-7 days')", []
    elif period == "month":
        return "WHERE date(timestamp) >= date('now', '-30 days')", []
    return "", []


def cmd_stats(args):
    conn = get_conn()
    where, params = period_filter(args.period) if hasattr(args, "period") and args.period else ("", [])

    rows = conn.execute(f"""
        SELECT
            COUNT(*) as count,
            SUM(numWords) as total_words,
            AVG(numWords) as avg_words,
            SUM(duration) as total_seconds,
            MIN(timestamp) as first,
            MAX(timestamp) as last
        FROM History {where}
    """, params).fetchone()

    by_app = conn.execute(f"""
        SELECT app, COUNT(*) as count, SUM(numWords) as words
        FROM History {where}
        WHERE app IS NOT NULL
        GROUP BY app ORDER BY words DESC LIMIT 10
    """, params).fetchall()

    label = args.period if hasattr(args, "period") and args.period else "all time"
    print(f"\nWispr Flow Stats — {label}")
    print("─" * 40)
    print(f"  Dictations:   {rows['count']:,}")
    print(f"  Total words:  {rows['total_words'] or 0:,}")
    print(f"  Avg words:    {int(rows['avg_words'] or 0):,}")
    mins = int((rows['total_seconds'] or 0) / 60)
    print(f"  Total time:   {mins} min")
    if rows["first"]:
        print(f"  Range:        {rows['first'][:10]} → {rows['last'][:10]}")
    print()
    if by_app:
        print("  Top apps:")
        for r in by_app:
            print(f"    {r['app']:<30} {r['words']:>6,} words  ({r['count']} dictations)")
    print()


def cmd_recent(args):
    conn = get_conn()
    limit = getattr(args, "limit", 20)
    rows = conn.execute("""
        SELECT timestamp, app, numWords, formattedText
        FROM History ORDER BY timestamp DESC LIMIT ?
    """, [limit]).fetchall()

    print(f"\nRecent {limit} dictations:\n")
    for r in rows:
        ts = r["timestamp"][:16] if r["timestamp"] else "?"
        text = (r["formattedText"] or "")[:100].replace("\n", " ")
        print(f"  [{ts}] {r['app'] or '?':20}  {r['numWords']:>4} words")
        print(f"         {text}")
        print()


def cmd_search(args):
    conn = get_conn()
    query = args.query
    where_clauses = ["formattedText LIKE ?"]
    params: list = [f"%{query}%"]

    if hasattr(args, "app") and args.app:
        where_clauses.append("app = ?")
        params.append(args.app)
    if hasattr(args, "from_date") and args.from_date:
        where_clauses.append("date(timestamp) >= ?")
        params.append(args.from_date)
    if hasattr(args, "to_date") and args.to_date:
        where_clauses.append("date(timestamp) <= ?")
        params.append(args.to_date)

    where = "WHERE " + " AND ".join(where_clauses)
    rows = conn.execute(f"""
        SELECT timestamp, app, numWords, formattedText
        FROM History {where}
        ORDER BY timestamp DESC LIMIT 50
    """, params).fetchall()

    print(f"\nSearch: '{query}' — {len(rows)} results\n")
    for r in rows:
        ts = r["timestamp"][:16] if r["timestamp"] else "?"
        text = r["formattedText"] or ""
        # Highlight match
        idx = text.lower().find(query.lower())
        if idx >= 0:
            start = max(0, idx - 60)
            snippet = ("..." if start > 0 else "") + text[start:idx + len(query) + 60] + "..."
        else:
            snippet = text[:120]
        snippet = snippet.replace("\n", " ")
        print(f"  [{ts}] {r['app'] or '?':20}  {r['numWords']} words")
        print(f"         {snippet}")
        print()


def cmd_export(args):
    conn = get_conn()
    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)

    rows = conn.execute("""
        SELECT timestamp, app, numWords, duration, formattedText
        FROM History ORDER BY timestamp ASC
    """).fetchall()

    if args.format == "obsidian":
        by_date: dict[str, list] = {}
        for r in rows:
            day = (r["timestamp"] or "unknown")[:10]
            by_date.setdefault(day, []).append(r)

        for day, entries in by_date.items():
            filepath = out / f"{day}-voice.md"
            lines = [f"---\ntype: voice-log\ndate: {day}\n---\n\n# Voice Log — {day}\n"]
            for e in entries:
                ts = (e["timestamp"] or "")[:16]
                lines.append(f"\n## [{ts}] {e['app'] or 'unknown'} — {e['numWords']} words\n")
                lines.append(e["formattedText"] or "")
                lines.append("")
            if not filepath.exists():
                filepath.write_text("\n".join(lines), encoding="utf-8")

        print(f"Exported {len(by_date)} daily notes to {out}")

    else:
        data = [dict(r) for r in rows]
        out_file = out / "wispr-export.json"
        out_file.write_text(json.dumps(data, indent=2), encoding="utf-8")
        print(f"Exported {len(data)} records to {out_file}")


def main():
    parser = argparse.ArgumentParser(description="Wispr Flow CLI")
    sub = parser.add_subparsers(dest="cmd")

    p_stats = sub.add_parser("stats")
    p_stats.add_argument("--period", choices=["today", "yesterday", "week", "month"])

    p_recent = sub.add_parser("recent")
    p_recent.add_argument("--limit", type=int, default=20)

    p_search = sub.add_parser("search")
    p_search.add_argument("query")
    p_search.add_argument("--app")
    p_search.add_argument("--from", dest="from_date")
    p_search.add_argument("--to", dest="to_date")

    p_export = sub.add_parser("export")
    p_export.add_argument("--format", choices=["obsidian", "json"], default="json")
    p_export.add_argument("--out", default="~/Downloads/wispr-export")

    p_dash = sub.add_parser("dashboard")
    p_dash.add_argument("--out", default="~/Downloads/wispr-dashboard.html")

    args = parser.parse_args()

    if args.cmd == "stats":
        cmd_stats(args)
    elif args.cmd == "recent":
        cmd_recent(args)
    elif args.cmd == "search":
        cmd_search(args)
    elif args.cmd == "export":
        cmd_export(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
