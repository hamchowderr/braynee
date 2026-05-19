#!/usr/bin/env python3
"""
Daily notes — open, log, plan, EOD summary.
Uses obsidian CLI for all vault writes.
"""

import os
import sys
import re
import json
import argparse
import subprocess
from pathlib import Path
from datetime import datetime, date, timedelta


def find_vault() -> Path | None:
    for candidate in [
        Path.home() / "Obsidian Vault",
        Path.home() / "vault",
        Path.home() / "Documents" / "Obsidian",
    ]:
        if (candidate / ".obsidian").is_dir():
            return candidate
    return None


def obsidian_eval(js_code: str):
    """Run JS in the Obsidian app via obsidian eval."""
    result = subprocess.run(
        ["obsidian", "eval", f'code={js_code}'],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"obsidian eval failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)


def daily_note_path(vault: Path, d: date) -> str:
    """Returns vault-relative path for a daily note."""
    return f"2. Areas/Sessions/{d.isoformat()}.md"


def daily_note_content(d: date) -> str:
    return f"""---
type: daily
date: {d.isoformat()}
---

# {d.isoformat()}

## Plan

- [ ]

## Log

## EOD

"""


def note_exists(vault_rel_path: str) -> bool:
    js = f"return !!app.vault.getFileByPath('{vault_rel_path}');"
    result = subprocess.run(
        ["obsidian", "eval", f"code=(async () => {{ {js} }})()"],
        capture_output=True, text=True
    )
    return "true" in result.stdout.lower()


def cmd_open(args, vault: Path):
    d = date.today()
    rel_path = daily_note_path(vault, d)
    content = daily_note_content(d)

    # Escape for JS string inside obsidian eval
    escaped = content.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
    rel_escaped = rel_path.replace("'", "\\'")

    js = (
        f"(async () => {{"
        f"  let f = app.vault.getFileByPath('{rel_escaped}');"
        f"  if (!f) f = await app.vault.create('{rel_escaped}', '{escaped}');"
        f"  app.workspace.openLinkText('', '{rel_escaped}', false);"
        f"}})()"
    )
    obsidian_eval(js)
    print(f"Opened: {rel_path}")


def cmd_yesterday(args, vault: Path):
    d = date.today() - timedelta(days=1)
    rel_path = daily_note_path(vault, d)
    rel_escaped = rel_path.replace("'", "\\'")

    js = (
        f"(async () => {{"
        f"  let f = app.vault.getFileByPath('{rel_escaped}');"
        f"  if (f) {{"
        f"    app.workspace.openLinkText('', '{rel_escaped}', false);"
        f"  }} else {{"
        f"    new Notice('No note found for {d.isoformat()}');"
        f"  }}"
        f"}})()"
    )
    obsidian_eval(js)
    print(f"Opened: {rel_path}")


def cmd_log(args, vault: Path):
    text = args.text
    d = date.today()
    rel_path = daily_note_path(vault, d)
    ts = datetime.now().strftime("%H:%M")
    log_line = f"[{ts}] {text}"

    content_escaped = daily_note_content(d).replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
    log_escaped = log_line.replace("\\", "\\\\").replace("'", "\\'")
    rel_escaped = rel_path.replace("'", "\\'")

    # Append to ## Log section, or create note if missing
    js = (
        f"(async () => {{"
        f"  let f = app.vault.getFileByPath('{rel_escaped}');"
        f"  if (!f) f = await app.vault.create('{rel_escaped}', '{content_escaped}');"
        f"  let cur = await app.vault.read(f);"
        f"  let updated;"
        f"  if (cur.includes('## Log')) {{"
        f"    updated = cur.replace('## Log', '## Log\\n{log_escaped}');"
        f"  }} else {{"
        f"    updated = cur + '\\n{log_escaped}';"
        f"  }}"
        f"  await app.vault.modify(f, updated);"
        f"}})()"
    )
    obsidian_eval(js)
    print(f"Logged: {log_line}")


def cmd_eod(args, vault: Path):
    """Print EOD summary — pulls open tasks and session count."""
    d = date.today()
    rel_path = daily_note_path(vault, d)
    rel_escaped = rel_path.replace("'", "\\'")

    js = (
        f"(async () => {{"
        f"  const f = app.vault.getFileByPath('{rel_escaped}');"
        f"  if (!f) return 'no daily note';"
        f"  return await app.vault.read(f);"
        f"}})()"
    )
    result = subprocess.run(
        ["obsidian", "eval", f"code={js}"],
        capture_output=True, text=True
    )
    content = result.stdout.strip() if result.returncode == 0 else ""

    # Count open tasks
    open_tasks = len(re.findall(r"- \[ \]", content))
    done_tasks = len(re.findall(r"- \[x\]", content, re.IGNORECASE))

    print(f"\nEOD — {d.isoformat()}")
    print(f"  Open tasks: {open_tasks}")
    print(f"  Done tasks: {done_tasks}")

    log_match = re.search(r"## Log\n(.*?)(?=\n## |\Z)", content, re.DOTALL)
    if log_match:
        log = log_match.group(1).strip()
        if log:
            print(f"\n  Log:\n" + "\n".join(f"    {l}" for l in log.splitlines()))


def main():
    parser = argparse.ArgumentParser(description="Daily notes")
    parser.add_argument("--vault", help="Vault path (auto-detected if omitted)")
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("open")
    sub.add_parser("yesterday")

    p_log = sub.add_parser("log")
    p_log.add_argument("text")

    sub.add_parser("eod")

    args = parser.parse_args()

    vault = Path(args.vault).expanduser() if getattr(args, "vault", None) else find_vault()
    if not vault:
        print("Vault not found. Use --vault to specify.", file=sys.stderr)
        sys.exit(1)

    if args.cmd == "open":
        cmd_open(args, vault)
    elif args.cmd == "yesterday":
        cmd_yesterday(args, vault)
    elif args.cmd == "log":
        cmd_log(args, vault)
    elif args.cmd == "eod":
        cmd_eod(args, vault)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
