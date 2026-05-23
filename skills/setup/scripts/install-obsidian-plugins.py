#!/usr/bin/env python3
"""
Install Obsidian community plugins by downloading from GitHub releases.
Writes plugin files + data.json defaults to vault/.obsidian/plugins/.
Updates community-plugins.json (the enabled-plugin list).

NOTE: Restricted mode (Settings > Community plugins > "Turn on community plugins")
cannot be set via files — it lives in Obsidian's internal storage. The setup wizard
checks for it and prompts the user once if needed.
"""

import json
import sys
import urllib.request
import urllib.error
from pathlib import Path
import argparse
from datetime import date


# Plugin ID must match the plugin's own manifest.json `id` field exactly.
# The folder name under .obsidian/plugins/ must also match.
PLUGINS = {
    "dataview": {
        "repo": "blacksmithgu/obsidian-dataview",
        "files": ["main.js", "manifest.json", "styles.css"],
        "data": {
            "renderNullAs": "\\-",
            "taskCompletionTracking": True,
            "taskCompletionUseEmojiShorthand": True,
            "taskCompletionText": "completion",
            "taskCompletionDateFormat": "yyyy-MM-dd",
            "warnOnEmptyResult": True,
            "refreshEnabled": True,
            "refreshInterval": 2500,
            "defaultDateFormat": "MMMM dd, yyyy",
            "defaultDateTimeFormat": "h:mm a - MMMM dd, yyyy",
            "tableIdColumnName": "File",
            "tableGroupColumnName": "Group",
            "showResultCount": True,
            "allowHtml": True,
            "inlineQueryPrefix": "=",
            "inlineJsQueryPrefix": "$=",
            "inlineQueriesInCodeblocks": True,
        },
    },
    "templater-obsidian": {
        "repo": "SilentVoid13/Templater",
        "files": ["main.js", "manifest.json", "styles.css"],
        "data": {
            "template_folder": "3. Resources/Templates",
            "auto_jump_to_cursor": True,
            "trigger_on_file_creation": False,
            "enable_system_commands": False,
            "syntax_highlighting": True,
            "enabled_templates_hotkeys": [],
            "startup_templates": [],
        },
    },
    "calendar": {
        "repo": "liamcain/obsidian-calendar-plugin",
        "files": ["main.js", "manifest.json"],
        "data": {
            "shouldConfirmBeforeCreate": False,
            "weekStart": "monday",
            "wordsPerDot": 250,
        },
    },
    "obsidian-git": {
        "repo": "denolehov/obsidian-git",
        "files": ["main.js", "manifest.json"],
        "data": {
            "commitMessage": "vault backup: {{date}}",
            "autoCommitMessage": "vault backup: {{date}}",
            "commitDateFormat": "YYYY-MM-DD HH:mm:ss",
            "autoSaveInterval": 10,
            "autoPushInterval": 10,
            "autoPullInterval": 10,
            "autoPullOnBoot": True,
            "autoCommitOnlyStaged": False,
            "disablePush": False,
            "pullBeforePush": True,
            "disablePopups": False,
            "disablePopupsForNoChanges": True,
            "listChangedFilesInMessageBody": True,
            "showStatusBar": True,
            "syncMethod": "merge",
            "autoBackupAfterFileChange": True,
            "refreshSourceControl": True,
        },
    },
    "obsidian-excalidraw-plugin": {
        "repo": "zsviczian/obsidian-excalidraw-plugin",
        "files": ["main.js", "manifest.json", "styles.css"],
        "data": {
            "folder": "2. Areas/Excalidraw",
            "templateFilePath": "",
            "autoexportSVG": False,
            "autoexportPNG": False,
            "autoexportWithTheme": False,
            "defaultMode": "normal",
            "width": "400",
            "exportWithTheme": True,
            "exportWithBackground": True,
            "matchTheme": True,
            "matchThemeAlways": False,
            "linkPrefix": "",
            "urlPrefix": "",
            "parseTODO": False,
            "todo": "- [ ]",
            "done": "- [x]",
        },
    },
    # TaskNotes is the vault-side surface for beads. braynee's
    # beads-status-sync.js writes task files into `tasksFolder` via the
    # mtn CLI; without this plugin the synced data has no renderer.
    "tasknotes": {
        "repo": "callumalpass/tasknotes",
        "files": ["main.js", "manifest.json", "styles.css"],
        "data": {
            "tasksFolder": "2. Areas/TaskNotes/Tasks",
            "archiveFolder": "2. Areas/TaskNotes/Archive",
            "moveArchivedTasks": False,
            "taskTag": "task",
            "taskIdentificationMethod": "tag",
            "defaultTaskPriority": "normal",
            "defaultTaskStatus": "open",
            "taskFilenameFormat": "zettel",
            "storeTitleInFilename": True,
            "customFilenameTemplate": "{title}",
        },
    },
}


def get_latest_release_url(repo: str, filename: str) -> str:
    api = f"https://api.github.com/repos/{repo}/releases/latest"
    req = urllib.request.Request(api, headers={"Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.load(resp)
    for asset in data.get("assets", []):
        if asset["name"] == filename:
            return asset["browser_download_url"]
    tag = data["tag_name"]
    return f"https://github.com/{repo}/releases/download/{tag}/{filename}"


def download_file(url: str, dest: Path) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            dest.write_bytes(resp.read())
        return True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False  # optional file (styles.css) — skip
        raise


def install_plugin(plugin_id: str, config: dict, plugins_dir: Path) -> dict:
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir(parents=True, exist_ok=True)

    results = {"id": plugin_id, "files": {}, "data": "skipped"}

    for filename in config["files"]:
        dest = plugin_dir / filename
        if dest.exists():
            results["files"][filename] = "exists"
            continue
        try:
            url = get_latest_release_url(config["repo"], filename)
            ok = download_file(url, dest)
            results["files"][filename] = "installed" if ok else "optional/missing"
        except Exception as e:
            results["files"][filename] = f"error: {e}"

    # Write data.json only if it doesn't exist (preserve user customizations)
    data_path = plugin_dir / "data.json"
    if not data_path.exists() and "data" in config:
        data_path.write_text(json.dumps(config["data"], indent=2), encoding="utf-8")
        results["data"] = "written"
    elif data_path.exists():
        results["data"] = "preserved (exists)"

    return results


def update_community_plugins(vault: Path, plugin_ids: list[str]):
    """Add plugin IDs to community-plugins.json (the enabled-plugin list)."""
    config_path = vault / ".obsidian" / "community-plugins.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)

    existing = []
    if config_path.exists():
        try:
            existing = json.loads(config_path.read_text(encoding="utf-8"))
        except Exception:
            existing = []

    added = []
    for pid in plugin_ids:
        if pid not in existing:
            existing.append(pid)
            added.append(pid)

    config_path.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    return added


def check_restricted_mode(vault: Path) -> bool:
    """
    Heuristic: if community-plugins.json already has entries AND plugin folders exist,
    restricted mode is likely already off. We can't check it directly.
    """
    cp = vault / ".obsidian" / "community-plugins.json"
    plugins_dir = vault / ".obsidian" / "plugins"
    if cp.exists() and plugins_dir.exists():
        try:
            ids = json.loads(cp.read_text(encoding="utf-8"))
            # If any plugin folder exists, Obsidian has been set up with plugins before
            return any((plugins_dir / pid).exists() for pid in ids)
        except Exception:
            pass
    return False


def main():
    parser = argparse.ArgumentParser(description="Install Obsidian community plugins")
    parser.add_argument("--vault", required=True, help="Path to Obsidian vault")
    parser.add_argument("--plugins", nargs="*", help="Specific plugin IDs (default: all)")
    parser.add_argument("--check", action="store_true", help="Check status without installing")
    args = parser.parse_args()

    vault = Path(args.vault)
    plugins_dir = vault / ".obsidian" / "plugins"

    if args.check:
        print("\nPlugin status:\n")
        for pid in PLUGINS:
            pdir = plugins_dir / pid
            main_js = pdir / "main.js"
            data_json = pdir / "data.json"
            cp = vault / ".obsidian" / "community-plugins.json"
            enabled_list = []
            if cp.exists():
                try:
                    enabled_list = json.loads(cp.read_text(encoding="utf-8"))
                except Exception:
                    pass
            installed = "✓" if main_js.exists() else "✗"
            has_data = "✓" if data_json.exists() else "✗"
            enabled = "✓" if pid in enabled_list else "✗"
            print(f"  {pid}")
            print(f"    files:{installed}  data.json:{has_data}  enabled:{enabled}")
        return

    plugins_dir.mkdir(parents=True, exist_ok=True)
    to_install = args.plugins if args.plugins else list(PLUGINS.keys())

    # Warn if restricted mode may not be off
    if not check_restricted_mode(vault):
        print("\n⚠  IMPORTANT: Before plugins will activate, you must:")
        print("   1. Open Obsidian")
        print("   2. Go to Settings > Community plugins")
        print("   3. Click 'Turn on community plugins'")
        print("   (This is a one-time step per vault)\n")

    results = []
    for plugin_id in to_install:
        if plugin_id not in PLUGINS:
            results.append({"id": plugin_id, "error": "unknown plugin ID"})
            continue
        print(f"  Installing {plugin_id}...")
        result = install_plugin(plugin_id, PLUGINS[plugin_id], plugins_dir)
        results.append(result)

    added = update_community_plugins(vault, to_install)

    print("\nResults:\n")
    for r in results:
        if "error" in r:
            print(f"  ✗ {r['id']} — {r['error']}")
        else:
            file_status = ", ".join(f"{k}: {v}" for k, v in r["files"].items())
            print(f"  ✓ {r['id']}  |  data.json: {r['data']}")

    if added:
        print(f"\nEnabled in community-plugins.json: {', '.join(added)}")

    print("\n→ Restart Obsidian to activate plugins.")
    print("   Per-plugin settings are in .obsidian/plugins/<id>/data.json")


if __name__ == "__main__":
    main()
