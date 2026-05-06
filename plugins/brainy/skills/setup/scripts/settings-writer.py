#!/usr/bin/env python3
"""
Write brainy-specific settings into ~/.claude/settings.json.

Hooks are now registered automatically via the plugin's hooks/hooks.json.
This script only handles settings that can't be expressed in hooks.json —
currently: autoMemoryDirectory (routes Claude Code auto memory to the vault).
"""

import json
import sys
import argparse
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

SETTINGS_PATH = Path.home() / ".claude" / "settings.json"


def find_vault() -> Path | None:
    for candidate in [
        Path.home() / "Obsidian Vault",
        Path.home() / "vault",
        Path.home() / "Documents" / "Obsidian",
    ]:
        if (candidate / ".obsidian").is_dir():
            return candidate
    return None


def load_settings() -> dict:
    if not SETTINGS_PATH.exists():
        return {}
    return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))


def save_settings(settings: dict):
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2), encoding="utf-8")


def cmd_detect(args):
    settings = load_settings()
    result = {
        "settings_exists": SETTINGS_PATH.exists(),
        "auto_memory_dir": settings.get("autoMemoryDirectory"),
    }
    print(json.dumps(result, indent=2))


def cmd_check(args):
    settings = load_settings()
    current = settings.get("autoMemoryDirectory")
    if current:
        print(f"  ✓  autoMemoryDirectory — {current}")
        print("\nNothing to add.")
    else:
        vault = find_vault()
        target = str(vault / "2. Areas" / "Claude Memory") if vault else "(vault not found)"
        print(f"  ○  autoMemoryDirectory — would be set to: {target}")
        print("\nRun 'apply --yes' to apply.")


def cmd_apply(args):
    dry_run = not getattr(args, "yes", False)
    settings = load_settings()

    if settings.get("autoMemoryDirectory"):
        print("Nothing to add — autoMemoryDirectory already set.")
        return

    vault = find_vault()
    if not vault:
        print("Vault not found — cannot set autoMemoryDirectory.", file=sys.stderr)
        print("Run with --vault to specify the path.", file=sys.stderr)
        sys.exit(1)

    value = str(vault / "2. Areas" / "Claude Memory")

    if dry_run:
        print(f"Would set autoMemoryDirectory → {value}")
        print("Run with --yes to apply.")
    else:
        settings["autoMemoryDirectory"] = value
        save_settings(settings)
        print(f"Set autoMemoryDirectory → {value}")
        print(f"Saved to {SETTINGS_PATH}")


def main():
    parser = argparse.ArgumentParser(
        description="Write brainy settings into ~/.claude/settings.json"
    )
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("detect", help="Output JSON describing current brainy settings")
    sub.add_parser("check", help="Show what would be added")

    p_apply = sub.add_parser("apply", help="Apply settings (dry-run unless --yes)")
    p_apply.add_argument("--yes", action="store_true", help="Actually write changes")
    p_apply.add_argument("--vault", help="Vault path (auto-detected if omitted)")

    args = parser.parse_args()

    if args.cmd == "detect":
        cmd_detect(args)
    elif args.cmd == "check":
        cmd_check(args)
    elif args.cmd == "apply":
        cmd_apply(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
