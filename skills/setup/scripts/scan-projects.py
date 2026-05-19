#!/usr/bin/env python3
"""
Scan the filesystem for git repositories regardless of parent folder name.
Searches common locations + does a depth-limited .git folder hunt from HOME.
"""

import os
import sys
import json
import subprocess
from pathlib import Path
from datetime import datetime, timezone

# Common project root folder names to check first (fast path)
COMMON_ROOTS = [
    "code", "projects", "dev", "Developer", "development",
    "repos", "repo", "src", "workspace", "work",
    "Sites", "sites", "source", "Sources",
    # Windows-specific
    "source/repos", "Documents/GitHub", "Documents/Projects",
    "Documents/Visual Studio 2022/Projects",
    "Documents/Visual Studio Code",
    "AppData/Local/Programs",
]

# Folders to never recurse into
SKIP_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv", "env",
    ".next", "dist", "build", "out", "coverage", ".cache",
    "Library", "AppData", "Applications", ".Trash", "Trash",
    "Music", "Movies", "Pictures", "Photos",
    "system32", "SysWOW64", "Windows",
}

TECH_MARKERS = {
    "package.json":      "Node.js",
    "next.config.js":    "Next.js",
    "next.config.ts":    "Next.js",
    "vite.config.ts":    "Vite",
    "vite.config.js":    "Vite",
    "requirements.txt":  "Python",
    "pyproject.toml":    "Python",
    "Cargo.toml":        "Rust",
    "go.mod":            "Go",
    "Gemfile":           "Ruby",
    "pom.xml":           "Java/Maven",
    "build.gradle":      "Java/Gradle",
    "composer.json":     "PHP",
    "pubspec.yaml":      "Flutter/Dart",
    "convex/":           "Convex",
    "supabase/":         "Supabase",
}


def last_commit_days_ago(repo_path: Path) -> int | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_path), "log", "-1", "--format=%ct"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0 and result.stdout.strip():
            ts = int(result.stdout.strip())
            delta = datetime.now(timezone.utc).timestamp() - ts
            return int(delta / 86400)
    except Exception:
        pass
    return None


def get_description(repo_path: Path) -> str:
    for name in ["README.md", "README.txt", "README"]:
        readme = repo_path / name
        if readme.exists():
            try:
                lines = readme.read_text(encoding="utf-8", errors="ignore").splitlines()
                for line in lines:
                    line = line.strip()
                    if line and not line.startswith("#") and len(line) > 10:
                        return line[:120]
                # fallback: first heading content
                for line in lines:
                    if line.startswith("#"):
                        return line.lstrip("#").strip()[:120]
            except Exception:
                pass
    return ""


def detect_stack(repo_path: Path) -> list[str]:
    stack = []
    for marker, label in TECH_MARKERS.items():
        if marker.endswith("/"):
            if (repo_path / marker.rstrip("/")).is_dir():
                stack.append(label)
        else:
            if (repo_path / marker).exists():
                if label not in stack:
                    stack.append(label)
    # Check package.json for framework hints
    pkg = repo_path / "package.json"
    if pkg.exists():
        try:
            data = json.loads(pkg.read_text(encoding="utf-8", errors="ignore"))
            deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
            if "next" in deps and "Next.js" not in stack:
                stack.append("Next.js")
            if "convex" in deps and "Convex" not in stack:
                stack.append("Convex")
            if "@supabase/supabase-js" in deps and "Supabase" not in stack:
                stack.append("Supabase")
            if "mastra" in deps:
                stack.append("Mastra")
            if "react" in deps and "React" not in stack:
                stack.append("React")
            if "express" in deps:
                stack.append("Express")
            if "fastapi" in deps:
                stack.append("FastAPI")
        except Exception:
            pass
    return list(dict.fromkeys(stack))  # dedupe preserving order


def scan_for_repos(root: Path, max_depth: int = 3, current_depth: int = 0) -> list[Path]:
    found = []
    if current_depth > max_depth:
        return found
    try:
        for entry in root.iterdir():
            if not entry.is_dir():
                continue
            if entry.name.startswith(".") and entry.name != ".git":
                continue
            if entry.name in SKIP_DIRS:
                continue
            if (entry / ".git").exists():
                found.append(entry)
            else:
                found.extend(scan_for_repos(entry, max_depth, current_depth + 1))
    except PermissionError:
        pass
    return found


def build_search_roots() -> list[Path]:
    home = Path.home()
    roots = []

    # Fast path: check named common roots first
    for rel in COMMON_ROOTS:
        candidate = home / rel
        if candidate.is_dir():
            roots.append(candidate)

    # Fallback: also scan home directly at depth 2 to catch anything missed
    # (avoids re-scanning already-found common roots)
    roots.append(home)
    return list(dict.fromkeys(roots))  # dedupe


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument("--active-only", action="store_true",
                        help="Only repos with commits in last 90 days")
    parser.add_argument("--depth", type=int, default=3,
                        help="Max folder depth to scan (default: 3)")
    args = parser.parse_args()

    search_roots = build_search_roots()
    seen: set[Path] = set()
    all_repos: list[dict] = []

    for root in search_roots:
        repos = scan_for_repos(root, max_depth=args.depth)
        for repo in repos:
            resolved = repo.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)

            days_ago = last_commit_days_ago(repo)
            if args.active_only and (days_ago is None or days_ago > 90):
                continue

            all_repos.append({
                "name": repo.name,
                "path": str(repo),
                "stack": detect_stack(repo),
                "description": get_description(repo),
                "days_since_commit": days_ago,
                "active": days_ago is not None and days_ago <= 90,
            })

    # Sort: active first, then by days_since_commit
    all_repos.sort(key=lambda r: (
        0 if r["active"] else 1,
        r["days_since_commit"] if r["days_since_commit"] is not None else 9999
    ))

    if args.json:
        print(json.dumps(all_repos, indent=2))
        return

    # Human-readable output
    active = [r for r in all_repos if r["active"]]
    inactive = [r for r in all_repos if not r["active"]]

    print(f"\nFound {len(all_repos)} repositories ({len(active)} active in last 90 days)\n")

    if active:
        print("ACTIVE PROJECTS")
        print("─" * 60)
        for r in active:
            stack_str = ", ".join(r["stack"]) if r["stack"] else "unknown"
            days = r["days_since_commit"]
            print(f"  {r['name']}")
            print(f"    Path:  {r['path']}")
            print(f"    Stack: {stack_str}")
            if r["description"]:
                print(f"    Desc:  {r['description']}")
            print(f"    Last commit: {days} day{'s' if days != 1 else ''} ago")
            print()

    if inactive:
        print("INACTIVE (>90 days)")
        print("─" * 60)
        for r in inactive:
            days = r["days_since_commit"]
            label = f"{days} days ago" if days is not None else "no commits"
            print(f"  {r['name']}  [{label}]  {r['path']}")
        print()


if __name__ == "__main__":
    main()
