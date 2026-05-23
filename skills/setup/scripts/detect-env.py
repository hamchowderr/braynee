#!/usr/bin/env python3
"""
Detect the user's environment: OS, vault path, installed tools, note apps, email/calendar.
"""

import os
import sys
import json
import shutil
import platform
import subprocess
from pathlib import Path

IS_MAC = platform.system() == "Darwin"
IS_WIN = platform.system() == "Windows"
HOME = Path.home()


# ── Vault ────────────────────────────────────────────────────────────────────

def find_vault() -> str | None:
    """Find Obsidian vault by locating .obsidian folder. Depth-limited to avoid hangs."""
    # Check direct/common locations first (fast path)
    fast_candidates = [
        HOME / "Obsidian Vault",
        HOME / "vault",
        HOME / "ObsidianVault",
        HOME / "Documents" / "Obsidian Vault",
        HOME / "Documents" / "vault",
        HOME / "OneDrive" / "Obsidian Vault",
        HOME / "iCloud Drive" / "Obsidian Vault",
    ]
    for candidate in fast_candidates:
        if (candidate / ".obsidian").is_dir():
            return str(candidate)

    # Depth-limited fallback scan (max 3 levels, skip large dirs)
    SKIP = {"node_modules", ".git", "Library", "AppData", "Applications",
            ".Trash", "Music", "Movies", "Pictures", "Windows", "system32"}
    scan_roots = [HOME / "Documents", HOME / "Desktop", HOME]
    for root in scan_roots:
        if not root.is_dir():
            continue
        result = _scan_for_obsidian(root, max_depth=3, skip=SKIP)
        if result:
            return result
    return None


def _scan_for_obsidian(path: Path, max_depth: int, skip: set, depth: int = 0) -> str | None:
    if depth > max_depth:
        return None
    try:
        if (path / ".obsidian").is_dir():
            return str(path)
        for child in path.iterdir():
            if not child.is_dir() or child.name in skip or child.name.startswith("."):
                continue
            result = _scan_for_obsidian(child, max_depth, skip, depth + 1)
            if result:
                return result
    except PermissionError:
        pass
    return None


# ── Tools ─────────────────────────────────────────────────────────────────────

def check_tool(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def check_tools() -> dict:
    tools = {
        "git":      check_tool("git"),
        "node":     check_tool("node"),
        "python3":  check_tool("python3") or check_tool("python") or check_tool("py"),
        "obsidian": check_tool("obsidian"),
        "bd":       check_tool("bd"),     # Beads
        "gws":      check_tool("gws"),    # Google Workspace CLI
    }
    # ProtonMail CLI — check common locations
    pm_paths = [
        HOME / ".claude/scripts/protonmail-cli/dist/cli.js",
        HOME / "code/protonmail-cli/dist/cli.js",
        Path("/usr/local/bin/protonmail-cli"),
    ]
    tools["protonmail_cli"] = any(p.exists() for p in pm_paths)
    tools["protonmail_cli_path"] = next(
        (str(p) for p in pm_paths if p.exists()), None
    )
    return tools


# ── Required Toolchain ────────────────────────────────────────────────────────

# Braynee hard dependencies. Setup uses every one of these directly:
#   git    — vault git init + the Obsidian Git auto-backup the plugin configures
#   node   — runs every braynee hook, monitor, and bundled script (qmd-wrapper …)
#   python3— runs the setup/migration/scaffold scripts
#   bd     — Beads is mandatory for all code projects
# QMD is required too but ships via the bundled qmd-wrapper, so it is verified
# separately in the workflow (node scripts/qmd-wrapper.mjs status), not here.
def check_toolchain() -> dict:
    """Return required-tool presence + per-OS install guidance for any missing."""

    def present(*cmds: str) -> bool:
        return any(shutil.which(c) is not None for c in cmds)

    if IS_MAC:
        plat = "mac"
        install = {
            "git":     "brew install git   (or: xcode-select --install)",
            "node":    "brew install node",
            "python3": "brew install python",
            "bd":      "npm install -g @beads/bd",
        }
    elif IS_WIN:
        plat = "windows"
        install = {
            "git":     "winget install --id Git.Git -e   (or: https://git-scm.com/download/win)",
            "node":    "winget install --id OpenJS.NodeJS.LTS -e",
            "python3": "winget install --id Python.Python.3.12 -e",
            "bd":      "irm https://raw.githubusercontent.com/gastownhall/beads/main/install.ps1 | iex   (or: npm install -g @beads/bd)",
        }
    else:
        plat = "linux"
        install = {
            "git":     "sudo apt install git   (or your distro's package manager)",
            "node":    "sudo apt install nodejs npm   (or: https://nodejs.org)",
            "python3": "sudo apt install python3",
            "bd":      "npm install -g @beads/bd",
        }

    found = {
        "git":     present("git"),
        "node":    present("node"),
        "python3": present("python3", "python", "py"),
        "bd":      present("bd"),
    }
    missing = [name for name, ok in found.items() if not ok]
    return {
        "platform": plat,
        "required": list(found.keys()),
        "found": found,
        "missing": missing,
        "install": {name: install[name] for name in missing},
        "all_present": len(missing) == 0,
    }


# ── Note Apps ─────────────────────────────────────────────────────────────────

def check_note_apps() -> dict:
    apps = {}

    if IS_MAC:
        # Apple Notes: always present on Mac
        apps["apple_notes"] = True

        # Notion
        notion_paths = [
            Path("/Applications/Notion.app"),
            HOME / "Applications/Notion.app",
        ]
        apps["notion"] = any(p.exists() for p in notion_paths)

        # Look for Notion export in Downloads/Documents
        notion_export = None
        for folder in [HOME / "Downloads", HOME / "Documents", HOME / "Desktop"]:
            for item in (folder.glob("Notion_Export*") if folder.exists() else []):
                notion_export = str(item)
                break
        apps["notion_export"] = notion_export

        # Apple Notes export (manual .enex or notes folder)
        apple_export = None
        for folder in [HOME / "Downloads", HOME / "Documents", HOME / "Desktop"]:
            for pattern in ["*.enex", "Apple Notes*", "Notes Export*"]:
                matches = list(folder.glob(pattern)) if folder.exists() else []
                if matches:
                    apple_export = str(matches[0])
                    break
        apps["apple_notes_export"] = apple_export

    if IS_WIN:
        apps["apple_notes"] = False

        # OneNote — check registry or app path
        onenote_paths = [
            Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/OneNote",
            Path("C:/Program Files/Microsoft Office/root/Office16/ONENOTE.EXE"),
        ]
        apps["onenote"] = any(p.exists() for p in onenote_paths)

        # Notion
        notion_local = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs/Notion/Notion.exe"
        apps["notion"] = notion_local.exists()

        # Notion export in Downloads
        notion_export = None
        downloads = HOME / "Downloads"
        if downloads.exists():
            for item in downloads.glob("Notion_Export*"):
                notion_export = str(item)
                break
        apps["notion_export"] = notion_export

    return apps


# ── Email & Calendar ──────────────────────────────────────────────────────────

def detect_email() -> str:
    if IS_MAC:
        # Check for ProtonMail Bridge
        bridge = Path("/Applications/Proton Mail Bridge.app")
        if bridge.exists():
            return "protonmail"
        # Check for Spark, Mimestream, Apple Mail (all ship with macOS)
        if Path("/Applications/Spark.app").exists():
            return "spark"
        if Path("/Applications/Mimestream.app").exists():
            return "gmail"
        # Default: Apple Mail (always installed)
        return "apple_mail"

    if IS_WIN:
        # Check for ProtonMail Bridge
        pm_win = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs/Proton Mail Bridge"
        if pm_win.exists():
            return "protonmail"
        return "outlook"

    return "unknown"


def detect_calendar() -> str:
    if IS_MAC:
        return "apple_calendar"  # always installed on Mac
    if IS_WIN:
        # Check for Google Calendar PWA or Outlook
        outlook = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/Outlook"
        if outlook.exists():
            return "outlook"
        return "unknown"  # user will confirm
    return "unknown"


# ── Claude Code Config ────────────────────────────────────────────────────────

def detect_claude_config() -> dict:
    """Detect existing Claude Code hooks, statusline, and second-brain state."""
    settings_path = Path.home() / ".claude" / "settings.json"
    result = {
        "settings_exists": settings_path.exists(),
        "hook_count": 0,
        "hooks": [],
        "has_statusline": False,
        "statusline_path": None,
        "has_vault_context": False,
        "has_session_tracking": False,
        "has_qmd": False,
        "plugin_hooks_installed": (Path.home() / ".claude" / "second-brain" / "hooks").exists(),
        "statusline_live_exists": (Path.home() / ".claude" / "statusline-live.json").exists(),
    }

    if not settings_path.exists():
        return result

    try:
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, PermissionError):
        result["settings_error"] = True
        return result

    # Claude Code's key is `statusLine` (camelCase), an object {type, command}.
    statusline = settings.get("statusLine")
    result["has_statusline"] = bool(statusline)
    result["statusline_path"] = (
        statusline.get("command") if isinstance(statusline, dict) else statusline
    )

    all_cmds: list[str] = []
    for event, entries in settings.get("hooks", {}).items():
        for entry in entries:
            for hook in entry.get("hooks", []):
                cmd = hook.get("command", "")
                if cmd:
                    all_cmds.append(cmd)
                    result["hooks"].append({"event": event, "command": cmd})

    result["hook_count"] = len(all_cmds)
    result["has_vault_context"] = any(
        any(t in c for t in ["vault-context", "vault context prime", "vault-context-prime"])
        for c in all_cmds
    )
    result["has_session_tracking"] = any(
        any(t in c for t in ["session-tracker", "session-export", "session-auto-track"])
        for c in all_cmds
    )
    result["has_qmd"] = any("qmd" in c for c in all_cmds)

    return result


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault",   action="store_true")
    parser.add_argument("--tools",   action="store_true")
    parser.add_argument("--toolchain", action="store_true",
                        help="Required-tool presence + per-OS install guidance")
    parser.add_argument("--notes",   action="store_true")
    parser.add_argument("--claude",  action="store_true")
    parser.add_argument("--all",     action="store_true")
    parser.add_argument("--json",    action="store_true")
    args = parser.parse_args()

    result = {}

    if args.all or args.vault:
        result["vault"] = find_vault()
        result["os"] = platform.system()
        result["os_version"] = platform.version()

    if args.all or args.tools:
        result["tools"] = check_tools()

    if args.all or args.toolchain:
        result["toolchain"] = check_toolchain()

    if args.all or args.notes:
        result["note_apps"] = check_note_apps()
        result["email"] = detect_email()
        result["calendar"] = detect_calendar()

    if args.all or args.claude:
        result["claude"] = detect_claude_config()

    if args.json or True:  # always JSON for scripting
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
