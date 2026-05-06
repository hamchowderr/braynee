#!/usr/bin/env python3
"""
Client relationship management.
Uses obsidian CLI for all vault writes.
"""

import os
import sys
import json
import argparse
import subprocess
import re
from pathlib import Path
from datetime import datetime, date


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


def qmd_search(query: str) -> str:
    qmd = Path.home() / ".claude" / "scripts" / "qmd-wrapper.mjs"
    result = subprocess.run(
        ["node", str(qmd), "search", query],
        capture_output=True, text=True
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def find_client_dir(vault: Path, client_name: str) -> Path | None:
    """Search for existing client folder across all businesses."""
    businesses_root = vault / "2. Areas" / "Business"
    if not businesses_root.exists():
        return None
    s = slug(client_name)
    for biz in businesses_root.iterdir():
        if not biz.is_dir():
            continue
        clients_root = biz / "Clients"
        if not clients_root.exists():
            continue
        for d in clients_root.iterdir():
            if d.is_dir() and (slug(d.name) == s or s in slug(d.name)):
                return d
    return None


def client_notes_template(client_name: str, company_name: str, business: str) -> str:
    return f"""---
type: client
name: {client_name}
company: {company_name}
business: {business}
status: active
rate: null
since: {date.today().strftime("%Y-%m")}
---

# {client_name}

## Relationship

## History

## Open Items

## Engagements

"""


def cmd_list(args, vault: Path):
    businesses_root = vault / "2. Areas" / "Business"
    if not businesses_root.exists():
        print("No business directory found.")
        return

    clients = []
    for biz in sorted(businesses_root.iterdir()):
        if not biz.is_dir():
            continue
        clients_root = biz / "Clients"
        if not clients_root.exists():
            continue
        for d in sorted(clients_root.iterdir()):
            if not d.is_dir():
                continue
            notes = d / "notes.md"
            status = "active"
            if notes.exists():
                content = notes.read_text(encoding="utf-8", errors="ignore")
                m = re.search(r"^status:\s*(\w+)", content, re.MULTILINE)
                if m:
                    status = m.group(1)
            clients.append((biz.name, d.name, status))

    if not clients:
        print("No clients found.")
        return

    print(f"\nClients ({len(clients)} total)\n")
    cur_biz = ""
    for biz, name, status in clients:
        if biz != cur_biz:
            print(f"  [{biz}]")
            cur_biz = biz
        marker = "✓" if status == "active" else "·"
        print(f"    {marker}  {name}  [{status}]")


def cmd_get(args, vault: Path):
    client_dir = find_client_dir(vault, args.client)
    if not client_dir:
        print(f"Client not found: {args.client}", file=sys.stderr)
        sys.exit(1)

    notes = client_dir / "notes.md"
    if notes.exists():
        print(notes.read_text(encoding="utf-8", errors="ignore"))
    else:
        print(f"Client directory found at {client_dir} but no notes.md")

    # List engagements
    eng_root = client_dir / "engagements"
    if eng_root.exists():
        engs = [d.name for d in sorted(eng_root.iterdir()) if d.is_dir()]
        if engs:
            print(f"\nEngagements:")
            for e in engs:
                print(f"  - {e}")


def cmd_log(args, vault: Path):
    client_dir = find_client_dir(vault, args.client)
    if not client_dir:
        print(f"Client not found: {args.client}. Create with: clients new '{args.client}'", file=sys.stderr)
        sys.exit(1)

    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    log_line = f"[{ts}] {args.text}"

    rel_path = str(client_dir / "notes.md").replace(str(vault) + os.sep, "").replace("\\", "/")
    rel_escaped = rel_path.replace("'", "\\'")
    log_escaped = log_line.replace("\\", "\\\\").replace("'", "\\'")

    js = (
        f"(async () => {{"
        f"  const f = app.vault.getFileByPath('{rel_escaped}');"
        f"  if (!f) return 'not found';"
        f"  const cur = await app.vault.read(f);"
        f"  const updated = cur.replace('## History', '## History\\n{log_escaped}');"
        f"  await app.vault.modify(f, updated);"
        f"}})()"
    )
    obsidian_eval(js)
    print(f"Logged to {client_dir.name}: {args.text}")


def cmd_new(args, vault: Path):
    client_name = args.client
    business = getattr(args, "business", None)

    if not business:
        # Default to first business folder found
        biz_root = vault / "2. Areas" / "Business"
        if biz_root.exists():
            dirs = [d for d in biz_root.iterdir() if d.is_dir()]
            business = dirs[0].name if dirs else "Otaku Solutions"
        else:
            business = "Otaku Solutions"

    client_slug = slug(client_name)
    client_dir = vault / "2. Areas" / "Business" / business / "Clients" / client_slug
    client_dir.mkdir(parents=True, exist_ok=True)
    (client_dir / "engagements").mkdir(exist_ok=True)

    notes_path = client_dir / "notes.md"
    if notes_path.exists():
        print(f"Client already exists: {client_dir}")
        return

    content = client_notes_template(client_name, client_name, business)
    escaped = content.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
    rel_path = str(notes_path).replace(str(vault) + os.sep, "").replace("\\", "/")
    rel_escaped = rel_path.replace("'", "\\'")

    js = f"(async () => {{ await app.vault.create('{rel_escaped}', '{escaped}'); }})()"
    obsidian_eval(js)
    print(f"Created client: {client_slug} ({business})")
    print(f"  Path: {client_dir}")


def cmd_prep(args, vault: Path):
    """Pull recent notes + context for a call prep brief."""
    client_dir = find_client_dir(vault, args.client)
    if not client_dir:
        print(f"Client not found: {args.client}", file=sys.stderr)
        sys.exit(1)

    print(f"\nCall Prep — {client_dir.name}\n")

    notes = client_dir / "notes.md"
    if notes.exists():
        content = notes.read_text(encoding="utf-8", errors="ignore")
        # Print relationship section
        m = re.search(r"## Relationship\n(.*?)(?=\n## |\Z)", content, re.DOTALL)
        if m and m.group(1).strip():
            print("Relationship context:")
            print(m.group(1).strip())
            print()
        # Print last 3 history entries
        m = re.search(r"## History\n(.*?)(?=\n## |\Z)", content, re.DOTALL)
        if m:
            history_lines = [l for l in m.group(1).splitlines() if l.strip()]
            if history_lines:
                print("Recent history:")
                for line in history_lines[-3:]:
                    print(f"  {line}")
                print()

    # QMD search for related notes
    print("Related notes (QMD):")
    results = qmd_search(client_dir.name)
    if results:
        print(results[:1000])
    else:
        print("  (none found)")


def main():
    parser = argparse.ArgumentParser(description="Client relationship management")
    parser.add_argument("--vault", help="Vault path (auto-detected if omitted)")
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("list")

    p_get = sub.add_parser("get")
    p_get.add_argument("client")

    p_log = sub.add_parser("log")
    p_log.add_argument("client")
    p_log.add_argument("text")

    p_new = sub.add_parser("new")
    p_new.add_argument("client")
    p_new.add_argument("--business")

    p_prep = sub.add_parser("prep")
    p_prep.add_argument("client")

    args = parser.parse_args()

    vault = Path(args.vault).expanduser() if getattr(args, "vault", None) else find_vault()
    if not vault:
        print("Vault not found. Use --vault to specify.", file=sys.stderr)
        sys.exit(1)

    if args.cmd == "list":
        cmd_list(args, vault)
    elif args.cmd == "get":
        cmd_get(args, vault)
    elif args.cmd == "log":
        cmd_log(args, vault)
    elif args.cmd == "new":
        cmd_new(args, vault)
    elif args.cmd == "prep":
        cmd_prep(args, vault)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
