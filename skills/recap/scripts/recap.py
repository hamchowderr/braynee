#!/usr/bin/env python3
"""
Recap — load context from previous Claude Code sessions.
Temporal mode: scans JSONL session files by date.
Graph mode: generates interactive HTML visualization.
"""

import os
import sys
import json
import argparse
import re
from pathlib import Path
from datetime import datetime, date, timedelta


PROJECTS_DIR = Path.home() / ".claude" / "projects"


def parse_date_expr(expr: str) -> tuple[date, date]:
    """Parse human date expressions to (start, end) date range."""
    expr = expr.lower().strip()
    today = date.today()

    if expr in ("today",):
        return today, today
    if expr in ("yesterday",):
        d = today - timedelta(days=1)
        return d, d
    if expr in ("this week",):
        monday = today - timedelta(days=today.weekday())
        return monday, today
    if expr in ("last week",):
        monday = today - timedelta(days=today.weekday() + 7)
        sunday = monday + timedelta(days=6)
        return monday, sunday

    # "last N days"
    m = re.match(r"last (\d+) days?", expr)
    if m:
        n = int(m.group(1))
        return today - timedelta(days=n - 1), today

    # "N days ago"
    m = re.match(r"(\d+) days? ago", expr)
    if m:
        n = int(m.group(1))
        d = today - timedelta(days=n)
        return d, d

    # "last monday" etc.
    days_map = {"monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
                "friday": 4, "saturday": 5, "sunday": 6}
    m = re.match(r"last (\w+day)", expr)
    if m and m.group(1) in days_map:
        target_wd = days_map[m.group(1)]
        days_back = (today.weekday() - target_wd) % 7 or 7
        d = today - timedelta(days=days_back)
        return d, d

    # ISO date
    try:
        d = date.fromisoformat(expr)
        return d, d
    except ValueError:
        pass

    raise ValueError(f"Cannot parse date expression: {expr!r}")


def find_session_files(start: date, end: date, all_projects: bool = False) -> list[Path]:
    """Find JSONL session files within date range."""
    if not PROJECTS_DIR.exists():
        return []

    files = []
    scan_root = PROJECTS_DIR if all_projects else PROJECTS_DIR

    for project_dir in scan_root.iterdir():
        if not project_dir.is_dir():
            continue
        for jsonl in project_dir.glob("*.jsonl"):
            try:
                mtime = date.fromtimestamp(jsonl.stat().st_mtime)
                if start <= mtime <= end:
                    files.append(jsonl)
            except Exception:
                pass

    return sorted(files, key=lambda f: f.stat().st_mtime, reverse=True)


def parse_session(jsonl_path: Path) -> dict:
    """Extract session metadata from JSONL file."""
    messages = []
    first_user_msg = ""
    try:
        lines = jsonl_path.read_text(encoding="utf-8", errors="ignore").splitlines()
        for line in lines:
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
                if entry.get("type") == "user" and not first_user_msg:
                    content = entry.get("message", {}).get("content", "")
                    if isinstance(content, list):
                        content = " ".join(
                            c.get("text", "") for c in content
                            if isinstance(c, dict) and c.get("type") == "text"
                        )
                    first_user_msg = str(content)[:100].replace("\n", " ")
                messages.append(entry)
            except json.JSONDecodeError:
                pass
    except Exception:
        pass

    msg_count = sum(1 for m in messages if m.get("type") in ("user", "assistant"))
    mtime = datetime.fromtimestamp(jsonl_path.stat().st_mtime)

    return {
        "session_id": jsonl_path.stem,
        "path": str(jsonl_path),
        "project": jsonl_path.parent.name,
        "mtime": mtime.isoformat(),
        "mtime_str": mtime.strftime("%H:%M"),
        "msg_count": msg_count,
        "first_msg": first_user_msg,
        "messages": messages,
    }


def cmd_list(args):
    date_expr = " ".join(args.date_expr) if isinstance(args.date_expr, list) else args.date_expr
    try:
        start, end = parse_date_expr(date_expr)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    min_msgs = getattr(args, "min_msgs", 3)
    all_projects = getattr(args, "all_projects", False)

    files = find_session_files(start, end, all_projects)
    sessions = [parse_session(f) for f in files]
    sessions = [s for s in sessions if s["msg_count"] >= min_msgs]

    label = f"{start}" if start == end else f"{start} → {end}"
    print(f"\nSessions — {label}  ({len(sessions)} found)\n")

    if not sessions:
        print("  No sessions found.")
        return

    print(f"  {'TIME':<8} {'MSGS':>5}  {'PROJECT':<30}  FIRST MESSAGE")
    print("  " + "─" * 80)
    for s in sessions:
        proj = s["project"][:28]
        first = s["first_msg"][:50]
        print(f"  {s['mtime_str']:<8} {s['msg_count']:>5}  {proj:<30}  {first}")
        print(f"  {'':8} {'':5}  ID: {s['session_id'][:40]}")
        print()


def cmd_expand(args):
    session_id = args.session_id
    target = None

    for project_dir in PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        candidate = project_dir / f"{session_id}.jsonl"
        if candidate.exists():
            target = candidate
            break
        # partial match
        matches = list(project_dir.glob(f"{session_id}*.jsonl"))
        if matches:
            target = matches[0]
            break

    if not target:
        print(f"Session not found: {session_id}", file=sys.stderr)
        sys.exit(1)

    session = parse_session(target)
    print(f"\nSession: {session['session_id']}")
    print(f"Project: {session['project']}")
    print(f"Time:    {session['mtime']}")
    print(f"Messages: {session['msg_count']}")
    print()

    for msg in session["messages"]:
        role = msg.get("type", "")
        if role not in ("user", "assistant"):
            continue
        content = msg.get("message", {}).get("content", "")
        if isinstance(content, list):
            content = " ".join(
                c.get("text", "") for c in content
                if isinstance(c, dict) and c.get("type") == "text"
            )
        content = str(content)[:200].replace("\n", " ")
        role_label = "You:" if role == "user" else "Claude:"
        print(f"  {role_label:<10} {content}")
    print()


def cmd_graph(args):
    date_expr = " ".join(args.date_expr) if isinstance(args.date_expr, list) else args.date_expr
    try:
        start, end = parse_date_expr(date_expr)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    files = find_session_files(start, end)
    sessions = [parse_session(f) for f in files]

    out = Path(getattr(args, "out", "~/Downloads/recap-graph.html")).expanduser()

    nodes = []
    edges = []
    file_nodes: dict[str, int] = {}

    for i, s in enumerate(sessions):
        nodes.append({
            "id": i, "label": s["mtime_str"],
            "title": f"{s['project']}\n{s['first_msg'][:80]}",
            "group": s["mtime"][:10],
            "shape": "dot", "size": min(30, 10 + s["msg_count"])
        })

    html = f"""<!DOCTYPE html>
<html><head><title>Recap Graph — {start} to {end}</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
<style>body{{margin:0}}#graph{{width:100vw;height:100vh}}</style>
</head><body>
<div id="graph"></div>
<script>
const nodes = new vis.DataSet({json.dumps(nodes)});
const edges = new vis.DataSet({json.dumps(edges)});
new vis.Network(document.getElementById('graph'), {{nodes, edges}}, {{
  physics: {{stabilization: true}},
  nodes: {{font: {{size: 12}}}},
}});
</script></body></html>"""

    out.write_text(html, encoding="utf-8")
    print(f"Graph saved to {out}")
    print(f"Open with: open {out}")


def main():
    parser = argparse.ArgumentParser(description="Recap session context")
    sub = parser.add_subparsers(dest="cmd")

    p_list = sub.add_parser("list")
    p_list.add_argument("date_expr", nargs="+")
    p_list.add_argument("--min-msgs", type=int, default=3)
    p_list.add_argument("--all-projects", action="store_true")

    p_expand = sub.add_parser("expand")
    p_expand.add_argument("session_id")

    p_graph = sub.add_parser("graph")
    p_graph.add_argument("date_expr", nargs="+")
    p_graph.add_argument("--out", default="~/Downloads/recap-graph.html")
    p_graph.add_argument("--min-files", type=int, default=0)

    args = parser.parse_args()

    if args.cmd == "list":
        cmd_list(args)
    elif args.cmd == "expand":
        cmd_expand(args)
    elif args.cmd == "graph":
        cmd_graph(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
