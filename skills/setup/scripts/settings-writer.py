#!/usr/bin/env python3
"""
Write braynee-specific settings into ~/.claude/settings.json.

Hooks are now registered automatically via the plugin's hooks/hooks.json.
This script handles settings that can't be expressed in hooks.json:

  • autoMemoryDirectory      — routes Claude Code auto memory to the vault.
  • permissions.defaultMode  — Braynee recommends starting sessions in
                               'plan' mode so work is reviewed before it
                               runs. Offered, never forced: dry-run unless
                               --yes, and an existing explicit value is only
                               changed on explicit consent.
"""

import json
import sys
import argparse
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

SETTINGS_PATH = Path.home() / ".claude" / "settings.json"
RULES_DIR = Path.home() / ".claude" / "rules"
RULES_TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "rules-templates"

# Braynee's recommended Claude Code default permission mode. 'plan' makes
# every session start in plan mode (review-before-act). Overridable via
# `apply --default-mode <value>` for users who prefer e.g. 'default'.
RECOMMENDED_DEFAULT_MODE = "plan"


def find_vault() -> Path | None:
    import os
    for env_var in ("BRAYNEE_VAULT", "OBSIDIAN_VAULT"):
        val = os.environ.get(env_var)
        if val:
            p = Path(val).expanduser()
            if p.is_dir():
                return p
    # A braynee vault: Obsidian marks it (.obsidian/) OR it carries the PARA
    # skeleton (>=2 numbered folders) — non-Obsidian markdown apps count too.
    _para = ("1. Projects", "2. Areas", "3. Resources", "4. Archives")
    for candidate in [
        Path.home() / "Obsidian Vault",
        Path.home() / "vault",
        Path.home() / "Documents" / "Obsidian",
        Path.home() / "Documents" / "Notes",
        Path.home() / "Notes",
    ]:
        if (candidate / ".obsidian").is_dir():
            return candidate
        if sum((candidate / m).is_dir() for m in _para) >= 2:
            return candidate
    return None


def load_settings() -> dict:
    if not SETTINGS_PATH.exists():
        return {}
    return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))


def save_settings(settings: dict):
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2), encoding="utf-8")


def get_default_mode(settings: dict):
    return settings.get("permissions", {}).get("defaultMode")


def set_default_mode(settings: dict, value: str):
    settings.setdefault("permissions", {})["defaultMode"] = value


def cmd_detect(args):
    settings = load_settings()
    result = {
        "settings_exists": SETTINGS_PATH.exists(),
        "auto_memory_dir": settings.get("autoMemoryDirectory"),
        "default_mode": get_default_mode(settings),
        "recommended_default_mode": RECOMMENDED_DEFAULT_MODE,
    }
    print(json.dumps(result, indent=2))


def cmd_check(args):
    settings = load_settings()
    pending = False

    # autoMemoryDirectory
    current_mem = settings.get("autoMemoryDirectory")
    if current_mem:
        print(f"  ✓  autoMemoryDirectory — {current_mem}")
    else:
        vault = find_vault()
        target = str(vault / "2. Areas" / "Claude Memory") if vault else "(vault not found)"
        print(f"  ○  autoMemoryDirectory — would be set to: {target}")
        pending = True

    # permissions.defaultMode
    current_mode = get_default_mode(settings)
    if current_mode == RECOMMENDED_DEFAULT_MODE:
        print(f"  ✓  permissions.defaultMode — {current_mode}")
    else:
        shown = current_mode if current_mode else "unset"
        print(
            f"  ○  permissions.defaultMode — currently {shown}; "
            f"Braynee recommends '{RECOMMENDED_DEFAULT_MODE}' "
            f"(review-before-act). Not changed without consent."
        )
        pending = True

    print("\nRun 'apply --yes' to apply." if pending else "\nNothing to add.")


def cmd_apply(args):
    dry_run = not getattr(args, "yes", False)
    settings = load_settings()
    changed = False

    # ── autoMemoryDirectory ──────────────────────────────────────────────
    if settings.get("autoMemoryDirectory"):
        print("autoMemoryDirectory — already set, skipping.")
    else:
        vault = Path(args.vault) if getattr(args, "vault", None) else find_vault()
        if not vault:
            print(
                "Vault not found — cannot set autoMemoryDirectory "
                "(pass --vault to specify).",
                file=sys.stderr,
            )
        else:
            value = str(vault / "2. Areas" / "Claude Memory")
            if dry_run:
                print(f"Would set autoMemoryDirectory → {value}")
            else:
                settings["autoMemoryDirectory"] = value
                changed = True
                print(f"Set autoMemoryDirectory → {value}")

    # ── permissions.defaultMode ──────────────────────────────────────────
    # Separate, explicit consent from autoMemoryDirectory: only touched when
    # --set-default-mode (or an explicit --default-mode value) is passed, so
    # a plain `apply --yes` never silently changes the permission mode.
    explicit_mode = getattr(args, "default_mode", None)
    do_mode = getattr(args, "set_default_mode", False) or explicit_mode is not None
    target_mode = explicit_mode or RECOMMENDED_DEFAULT_MODE
    current_mode = get_default_mode(settings)
    if not do_mode:
        if current_mode != target_mode:
            shown = current_mode if current_mode else "unset"
            print(
                f"permissions.defaultMode — {shown}; "
                f"pass --set-default-mode to set '{target_mode}' (skipped)."
            )
    elif current_mode == target_mode:
        print(f"permissions.defaultMode — already '{target_mode}', skipping.")
    else:
        shown = current_mode if current_mode else "unset"
        if dry_run:
            print(f"Would set permissions.defaultMode {shown} → {target_mode}")
        else:
            set_default_mode(settings, target_mode)
            changed = True
            print(f"Set permissions.defaultMode {shown} → {target_mode}")

    if dry_run:
        print("\nRun with --yes to apply.")
    elif changed:
        save_settings(settings)
        print(f"\nSaved to {SETTINGS_PATH}")
    else:
        print("\nNothing changed.")


def cmd_rules(args):
    """Provision ~/.claude/rules/ with generic universal templates.

    Default behavior: copy each template only if a same-named file doesn't
    already exist (so we never clobber a user-customized rule). --force
    overrides. --check shows what would happen without writing.
    """
    dry_run = not getattr(args, "yes", False)
    force = getattr(args, "force", False)

    if not RULES_TEMPLATES_DIR.is_dir():
        print(
            f"Templates dir not found: {RULES_TEMPLATES_DIR}\n"
            "(This should ship with braynee — investigate plugin install.)",
            file=sys.stderr,
        )
        sys.exit(1)

    templates = sorted(RULES_TEMPLATES_DIR.glob("*.md"))
    if not templates:
        print(f"No templates in {RULES_TEMPLATES_DIR}.")
        return

    RULES_DIR.mkdir(parents=True, exist_ok=True)
    actions = []
    for tpl in templates:
        dest = RULES_DIR / tpl.name
        if dest.exists() and not force:
            actions.append(("skip-existing", tpl, dest))
        elif dest.exists() and force:
            actions.append(("overwrite", tpl, dest))
        else:
            actions.append(("create", tpl, dest))

    for action, tpl, dest in actions:
        symbol = {"create": "○", "overwrite": "↻", "skip-existing": "✓"}[action]
        verb = {
            "create": "would create" if dry_run else "created",
            "overwrite": "would OVERWRITE" if dry_run else "overwrote",
            "skip-existing": "exists (use --force to overwrite)",
        }[action]
        print(f"  {symbol}  {dest.name} — {verb}")
        if not dry_run and action in ("create", "overwrite"):
            dest.write_bytes(tpl.read_bytes())

    if dry_run:
        any_pending = any(a[0] in ("create", "overwrite") for a in actions)
        print("\nRun with --yes to apply." if any_pending else "\nNothing to add.")
    else:
        print(f"\nRules in {RULES_DIR}")
        print(
            "\nNext: open each file and replace {{placeholders}} with your "
            "actual stack (or delete blocks you don't use)."
        )


def main():
    parser = argparse.ArgumentParser(
        description="Write braynee settings into ~/.claude/settings.json"
    )
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("detect", help="Output JSON describing current braynee settings")
    sub.add_parser("check", help="Show what would be added")

    p_apply = sub.add_parser("apply", help="Apply settings (dry-run unless --yes)")
    p_apply.add_argument("--yes", action="store_true", help="Actually write changes")
    p_apply.add_argument("--vault", help="Vault path (auto-detected if omitted)")
    p_apply.add_argument(
        "--set-default-mode",
        action="store_true",
        help=f"Also set permissions.defaultMode to '{RECOMMENDED_DEFAULT_MODE}' "
        f"(separate consent from autoMemoryDirectory)",
    )
    p_apply.add_argument(
        "--default-mode",
        help="Permission mode value to set (implies --set-default-mode; "
        f"default: {RECOMMENDED_DEFAULT_MODE})",
    )

    p_rules = sub.add_parser(
        "rules",
        help="Provision ~/.claude/rules/ with universal templates (dev-defaults + secrets)",
    )
    p_rules.add_argument("--yes", action="store_true", help="Actually write files")
    p_rules.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing rule files (default: skip existing)",
    )

    args = parser.parse_args()

    if args.cmd == "detect":
        cmd_detect(args)
    elif args.cmd == "check":
        cmd_check(args)
    elif args.cmd == "apply":
        cmd_apply(args)
    elif args.cmd == "rules":
        cmd_rules(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
