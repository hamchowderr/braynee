#!/usr/bin/env python3
"""
Brain Check — Setup, Connections, Memory, Inbox.
"""

import os
import sys
import json
sys.stdout.reconfigure(encoding="utf-8")
import argparse
import subprocess
import shutil
from pathlib import Path
from datetime import date, timedelta, datetime


def find_vault() -> Path | None:
    for candidate in [
        Path.home() / "Obsidian Vault",
        Path.home() / "vault",
        Path.home() / "Documents" / "Obsidian",
    ]:
        if (candidate / ".obsidian").is_dir():
            return candidate
    return None


def check_tool(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def ok(label: str):
    print(f"  ✓  {label}")


def warn(label: str):
    print(f"  ✗  {label}")


def run_version(cmd: list[str], timeout: int = 5) -> str | None:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if r.returncode == 0:
            return r.stdout.strip().splitlines()[0] if r.stdout.strip() else "(ok)"
        return None
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None


def cmd_check(args, vault: Path):
    print("\n── Brain Check ─────────────────────────────────────────────\n")
    cmd_setup(args, vault)
    print()
    cmd_connections(args, vault)
    print()
    cmd_memory(args, vault)
    print()
    cmd_inbox(args, vault)
    print()


def cmd_setup(args, vault: Path):
    print("Setup — Tools and scripts installed?\n")

    tool_checks = [
        (["git", "--version"],        "git — version control"),
        (["node", "--version"],       "node — Node.js runtime"),
        (["python3", "--version"],    "python3 — Python runtime"),
        (["obsidian", "--version"],   "obsidian — CLI"),
        (["bd", "version"],           "bd — Beads issue tracker"),
        (["curl", "--version"],       "curl — HTTP client"),
    ]
    for cmd_args, label in tool_checks:
        version = run_version(cmd_args)
        if version:
            ok(f"{label} ({version})")
        else:
            warn(f"{label} — NOT FOUND")

    qmd_wrapper = Path.home() / ".claude" / "scripts" / "qmd-wrapper.mjs"
    if not qmd_wrapper.exists():
        warn("qmd — wrapper not found at ~/.claude/scripts/qmd-wrapper.mjs")
    else:
        r = subprocess.run(
            ["node", str(qmd_wrapper), "status"],
            capture_output=True, text=True, timeout=10
        )
        if r.returncode == 0:
            ok("qmd — search engine (installed)")
        else:
            warn("qmd — wrapper exists but not responding")

    hooks_dir = Path.home() / ".claude" / "hooks"
    for hook in ["vault-context-prime.js", "session-auto-track.js", "session-export-qmd.js", "statusline-state.js"]:
        p = hooks_dir / hook
        if p.exists():
            ok(f"hook: {hook}")
        else:
            warn(f"hook: {hook} — missing at {p}")

    settings_path = Path.home() / ".claude" / "settings.json"
    if settings_path.exists():
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
        all_cmds = [
            h.get("command", "")
            for entries in settings.get("hooks", {}).values()
            for e in entries for h in e.get("hooks", [])
        ]
        for feature, term in [
            ("vault_context", "vault-context-prime"),
            ("session_tracking", "session-auto-track"),
            ("qmd_sync", "session-export-qmd"),
        ]:
            if any(term in c for c in all_cmds):
                ok(f"settings: {feature} hook registered")
            else:
                warn(f"settings: {feature} hook NOT registered")
    else:
        warn("settings.json not found")

    plugin_root = Path(__file__).parent.parent.parent
    for skill in ["setup", "daily", "wispr", "granola", "tasks", "recall",
                  "sessions", "clients", "query", "health", "zettelkasten", "settings-viewer"]:
        skill_md = plugin_root / skill / "SKILL.md"
        if skill_md.exists():
            ok(f"skill: {skill}")
        else:
            warn(f"skill: {skill} — SKILL.md missing")


def cmd_connections(args, vault: Path):
    print("Connections — Live integrations reachable?\n")

    result = subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
         "--max-time", "3", "http://127.0.0.1:8090/api/health"],
        capture_output=True, text=True
    )
    if result.stdout.strip().startswith("2"):
        ok("TaskNotes API (http://127.0.0.1:8090)")
    else:
        warn("TaskNotes API not responding (start Obsidian TaskNotes plugin)")

    if check_tool("bd"):
        ok("Beads (bd) available")
    else:
        warn("Beads (bd) not found")

    granola_cache = Path.home() / "Library" / "Application Support" / "Granola" / "cache-v3.json"
    if sys.platform != "darwin":
        ok("Granola (macOS only, skipped)")
    elif granola_cache.exists():
        age = (date.today() - date.fromtimestamp(granola_cache.stat().st_mtime)).days
        ok(f"Granola cache ({age}d old)")
    else:
        warn("Granola cache not found (open Granola app)")

    if check_tool("obsidian"):
        ok("obsidian CLI available")
    else:
        warn("obsidian CLI not found")

    qmd_wrapper = Path.home() / ".claude" / "scripts" / "qmd-wrapper.mjs"
    if qmd_wrapper.exists():
        result = subprocess.run(
            ["node", str(qmd_wrapper), "status", "--json"],
            capture_output=True, text=True, timeout=10
        )
        try:
            s = json.loads(result.stdout)
            collections = s.get("collections", [])
            doc_count = sum(c.get("documents", 0) for c in collections)
            last_indexed = max((c.get("lastIndexed", 0) for c in collections), default=0)
            if last_indexed:
                last_dt = datetime.fromtimestamp(last_indexed / 1000)
                age_hours = (datetime.now() - last_dt).total_seconds() / 3600
                age_str = f"{int(age_hours)}h ago" if age_hours < 48 else f"{int(age_hours/24)}d ago"
                if age_hours > 48:
                    warn(f"QMD index stale: {doc_count} docs, last indexed {age_str}")
                else:
                    ok(f"QMD index: {doc_count} docs, indexed {age_str}")
            else:
                ok(f"QMD index: {doc_count} docs")
        except (json.JSONDecodeError, KeyError):
            ok("QMD installed (run `qmd status` for details)")
    else:
        warn("QMD wrapper not found")


def cmd_memory(args, vault: Path):
    print("Memory — Is Claude loaded with current context?\n")

    claude_md = vault / "CLAUDE.md"
    if claude_md.exists():
        age = (date.today() - date.fromtimestamp(claude_md.stat().st_mtime)).days
        if age > 30:
            warn(f"Vault CLAUDE.md last modified {age} days ago — may be stale")
        else:
            ok(f"Vault CLAUDE.md current ({age}d ago)")
    else:
        warn("CLAUDE.md missing from vault root")

    global_claude_md = Path.home() / ".claude" / "CLAUDE.md"
    if global_claude_md.exists():
        age = (date.today() - date.fromtimestamp(global_claude_md.stat().st_mtime)).days
        if age > 30:
            warn(f"Global CLAUDE.md last modified {age} days ago — may be stale")
        else:
            ok(f"Global CLAUDE.md current ({age}d ago)")
    else:
        warn("~/.claude/CLAUDE.md missing")

    context_dir = vault / "2. Areas" / "context"
    for fname in ["about-me.md", "about-business.md", "priorities.md"]:
        p = context_dir / fname
        if p.exists():
            ok(fname)
        else:
            warn(f"{fname} missing (create in 2. Areas/context/)")

    memory_dir = vault / "2. Areas" / "Claude Memory"
    if memory_dir.exists():
        count = len(list(memory_dir.glob("*.md")))
        ok(f"Claude Memory — vault ({count} entries)")
    else:
        warn("Claude Memory directory missing")

    # Claude Code auto memory: ~/.claude/projects/<project>/memory/
    projects_dir = Path.home() / ".claude" / "projects"
    if projects_dir.exists():
        auto_memory_dirs = [
            p for p in projects_dir.iterdir()
            if p.is_dir() and (p / "memory" / "MEMORY.md").exists()
        ]
        if auto_memory_dirs:
            for amd in auto_memory_dirs:
                mem_md = amd / "memory" / "MEMORY.md"
                lines = len(mem_md.read_text(encoding="utf-8").splitlines())
                ok(f"Auto memory — {amd.name[:40]} ({lines} lines)")
        else:
            warn("Auto memory — no project memory directories found")


def cmd_inbox(args, vault: Path):
    print("Inbox — What's backed up or unprocessed?\n")

    inbox = vault / "Inbox"
    if inbox.exists():
        items = len(list(inbox.glob("*.md")))
        if items == 0:
            ok("Inbox: empty")
        elif items <= 5:
            warn(f"Inbox: {items} items waiting")
        else:
            warn(f"Inbox: {items} items — process soon")
    else:
        warn("Inbox folder not found")

    sessions_dir = vault / "2. Areas" / "Sessions"
    if sessions_dir.exists():
        week_ago = date.today() - timedelta(days=7)
        recent = [
            f for f in sessions_dir.rglob("*.md")
            if date.fromtimestamp(f.stat().st_mtime) >= week_ago
        ]
        if recent:
            ok(f"Sessions: {len(recent)} synced this week")
        else:
            warn("Sessions: none synced this week")

    settings_path = Path.home() / ".claude" / "settings.json"
    if settings_path.exists():
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
        all_cmds = [
            h.get("command", "")
            for entries in settings.get("hooks", {}).values()
            for e in entries for h in e.get("hooks", [])
        ]
        if not any("session-tracker" in c for c in all_cmds):
            warn("Session tracker hook not registered — sessions may not be auto-syncing")


def main():
    parser = argparse.ArgumentParser(description="Brain Check — Brainy system health")
    parser.add_argument("--vault", help="Vault path (auto-detected if omitted)")
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("check")
    sub.add_parser("setup")
    sub.add_parser("connections")
    sub.add_parser("memory")
    sub.add_parser("inbox")

    args = parser.parse_args()

    vault = Path(args.vault).expanduser() if getattr(args, "vault", None) else find_vault()
    if not vault:
        print("Vault not found. Use --vault to specify.", file=sys.stderr)
        sys.exit(1)

    if args.cmd == "check" or args.cmd is None:
        cmd_check(args, vault)
    elif args.cmd == "setup":
        cmd_setup(args, vault)
    elif args.cmd == "connections":
        cmd_connections(args, vault)
    elif args.cmd == "memory":
        cmd_memory(args, vault)
    elif args.cmd == "inbox":
        cmd_inbox(args, vault)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
