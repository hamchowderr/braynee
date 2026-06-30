#!/usr/bin/env python3
"""provision-formulas.py — copy braynee's canonical workflow formulas into the user's
global ~/.beads/formulas/ so `bd mol pour <name>` (autonomous-ship, project,
engagement, braynee-release) works right after setup with no manual file copy. (cp-2u2)

Idempotent; braynee's formulas are the canonical source, so this overwrites same-named
files in the destination. Run by braynee setup; also runnable standalone.

Usage: python3 provision-formulas.py [--dest <dir>] [--dry-run]
"""
import argparse
import shutil
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description="Provision braynee workflow formulas into ~/.beads/formulas/.")
    ap.add_argument("--dest", default=str(Path.home() / ".beads" / "formulas"),
                    help="destination formulas dir (default: ~/.beads/formulas)")
    ap.add_argument("--dry-run", action="store_true", help="show what would be copied, write nothing")
    args = ap.parse_args()

    # This script is at skills/setup/scripts/ → up 4 to the plugin root → formulas/.
    src = Path(__file__).resolve().parents[3] / "formulas"
    dest = Path(args.dest)

    formulas = sorted(src.glob("*.formula.toml"))
    if not formulas:
        print(f"No formulas found at {src} — nothing to provision.")
        return 1

    if not args.dry_run:
        dest.mkdir(parents=True, exist_ok=True)

    for f in formulas:
        target = dest / f.name
        if args.dry_run:
            print(f"  [dry-run] {f.name} -> {target}")
        else:
            shutil.copy2(f, target)
            print(f"  + {f.name} -> {target}")

    prefix = "[dry-run] " if args.dry_run else ""
    print(f"{prefix}{len(formulas)} formula(s) {'would be ' if args.dry_run else ''}provisioned to {dest}")
    print("  pour with: bd mol pour autonomous-ship --var name=<x> --var repo=owner/name --var branch=feature/<x> --var deploy_target=<target>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
