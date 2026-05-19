#!/usr/bin/env python3
"""
Migrate Notion export (zip or folder, markdown or HTML) to Obsidian markdown in vault Inbox/.

Usage:
  python3 migrate-notion.py --export ~/Downloads/Notion_Export.zip --out ~/vault/Inbox
  python3 migrate-notion.py --export ~/Downloads/notion-folder --out ~/vault/Inbox --json
"""

import re
import sys
import json
import shutil
import zipfile
import argparse
import tempfile
from pathlib import Path
from datetime import date
from html.parser import HTMLParser


# ── HTML → Markdown ───────────────────────────────────────────────────────────

class HtmlToMarkdown(HTMLParser):
    def __init__(self):
        super().__init__()
        self.result: list[str] = []
        self._stack: list[str] = []
        self._list_counters: list[int] = []
        self._in_head = False
        self._link_href = ""

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        self._stack.append(tag)
        if tag in ("head", "style", "script"):
            self._in_head = True
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.result.append("\n" + "#" * int(tag[1]) + " ")
        elif tag in ("strong", "b"):
            self.result.append("**")
        elif tag in ("em", "i"):
            self.result.append("*")
        elif tag == "a":
            self._link_href = attrs_dict.get("href", "")
            self.result.append("[")
        elif tag == "ul":
            self._list_counters.append(-1)
        elif tag == "ol":
            self._list_counters.append(0)
        elif tag == "li":
            if self._list_counters:
                if self._list_counters[-1] == -1:
                    self.result.append("\n- ")
                else:
                    self._list_counters[-1] += 1
                    self.result.append(f"\n{self._list_counters[-1]}. ")
        elif tag in ("p", "div"):
            self.result.append("\n")
        elif tag == "br":
            self.result.append("\n")
        elif tag == "hr":
            self.result.append("\n---\n")
        elif tag == "code":
            self.result.append("`")
        elif tag == "pre":
            self.result.append("\n```\n")

    def handle_endtag(self, tag):
        if self._stack and self._stack[-1] == tag:
            self._stack.pop()
        if tag in ("head", "style", "script"):
            self._in_head = False
        elif tag in ("strong", "b"):
            self.result.append("**")
        elif tag in ("em", "i"):
            self.result.append("*")
        elif tag == "a":
            self.result.append(f"]({self._link_href})")
            self._link_href = ""
        elif tag in ("ul", "ol"):
            if self._list_counters:
                self._list_counters.pop()
            self.result.append("\n")
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6", "p", "div"):
            self.result.append("\n")
        elif tag == "code":
            self.result.append("`")
        elif tag == "pre":
            self.result.append("\n```\n")

    def handle_data(self, data):
        if self._in_head:
            return
        self.result.append(data)

    def get_markdown(self) -> str:
        text = "".join(self.result)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


def html_to_markdown(html: str) -> tuple[str, str]:
    parser = HtmlToMarkdown()
    parser.feed(html)
    md = parser.get_markdown()
    lines = md.splitlines()
    title = ""
    for line in lines:
        stripped = line.lstrip("#").strip()
        if stripped:
            title = stripped
            break
    return title, md


# ── Helpers ───────────────────────────────────────────────────────────────────

# Notion appends a 32-char hex UUID to filenames: "My Note abc123def456abcdef123456.md"
NOTION_UUID_RE = re.compile(r"\s+[0-9a-f]{32}$", re.IGNORECASE)

def strip_notion_uuid(stem: str) -> str:
    return NOTION_UUID_RE.sub("", stem).strip()


def slugify(text: str, max_len: int = 80) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s\-]", "", text)
    text = re.sub(r"[\s]+", "-", text.strip())
    text = re.sub(r"-{2,}", "-", text)
    return text[:max_len].rstrip("-") or "untitled"


def has_frontmatter(text: str) -> bool:
    return text.lstrip().startswith("---")


def inject_frontmatter(content: str, title: str) -> str:
    fm = (
        f"---\ntype: inbox\nsource: notion\ntitle: \"{title}\"\n"
        f"imported: {date.today().isoformat()}\n---\n\n"
    )
    return fm + content


def safe_write(dest: Path, content: str) -> str:
    if dest.exists():
        return "skipped"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(content, encoding="utf-8")
    return "written"


# ── Processing ────────────────────────────────────────────────────────────────

def process_folder(src: Path, out: Path, results: dict):
    """Process all .md and .html files in src, writing to out (flat)."""
    # Collect all processable files, skip those with a .csv sidecar (Notion auto-export)
    all_files = list(src.rglob("*.md")) + list(src.rglob("*.html")) + list(src.rglob("*.htm"))

    csv_stems = {f.stem for f in src.rglob("*.csv")}

    for src_file in sorted(all_files):
        # Skip Notion auto-generated index files with matching CSV
        if src_file.stem in csv_stems:
            results["skipped"] += 1
            continue

        try:
            if src_file.suffix.lower() == ".md":
                content = src_file.read_text(encoding="utf-8", errors="replace")
                clean_title = strip_notion_uuid(src_file.stem)
                slug = slugify(clean_title)
                if not has_frontmatter(content):
                    content = inject_frontmatter(content, clean_title)
                dest = out / f"{slug}.md"

            else:  # .html / .htm
                html = src_file.read_text(encoding="utf-8", errors="replace")
                title, body = html_to_markdown(html)
                clean_title = strip_notion_uuid(src_file.stem) if not title else title
                slug = slugify(clean_title)
                dest = out / f"{slug}.md"
                fm = (
                    f"---\ntype: inbox\nsource: notion\ntitle: \"{clean_title}\"\n"
                    f"imported: {date.today().isoformat()}\n---\n\n"
                )
                content = fm + body + "\n"

            result = safe_write(dest, content)
            if result == "written":
                results["migrated"] += 1
                results["files"].append(str(dest))
            else:
                results["skipped"] += 1

        except Exception as e:
            print(f"  failed: {src_file.name} — {e}", file=sys.stderr)
            results["failed"] += 1


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Migrate Notion export to Obsidian Inbox")
    parser.add_argument("--export", required=True, help="Path to Notion export zip or folder")
    parser.add_argument("--out",    required=True, help="Path to vault Inbox/ directory")
    parser.add_argument("--json",   action="store_true", help="Output JSON summary")
    args = parser.parse_args()

    export_path = Path(args.export).expanduser()
    out_path    = Path(args.out).expanduser()

    if not export_path.exists():
        print(f"error: export path not found: {export_path}", file=sys.stderr)
        sys.exit(1)

    results = {"migrated": 0, "skipped": 0, "failed": 0, "files": []}
    tmp_dir = None

    try:
        if export_path.suffix.lower() == ".zip":
            if not zipfile.is_zipfile(export_path):
                print(f"error: not a valid zip file: {export_path}", file=sys.stderr)
                sys.exit(1)
            tmp_dir = tempfile.mkdtemp(prefix="notion-migrate-")
            with zipfile.ZipFile(export_path) as zf:
                zf.extractall(tmp_dir)
            src = Path(tmp_dir)
        elif export_path.is_dir():
            src = export_path
        else:
            print(f"error: --export must be a .zip file or folder: {export_path}", file=sys.stderr)
            sys.exit(1)

        process_folder(src, out_path, results)

    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    if args.json:
        print(json.dumps(results))
    else:
        m, s, f = results["migrated"], results["skipped"], results["failed"]
        print(f"Migrated {m} notes, skipped {s} (already exist), failed {f}")


if __name__ == "__main__":
    main()
