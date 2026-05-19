#!/usr/bin/env python3
"""
Migrate OneNote HTML export to Obsidian markdown in vault Inbox/.
Preserves section folder structure under Inbox/.

Usage:
  python3 migrate-onenote.py --export ~/Downloads/OneNote --out ~/vault/Inbox
  python3 migrate-onenote.py --export ... --out ... --json
"""

import re
import sys
import json
import argparse
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

def slugify(text: str, max_len: int = 80) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s\-]", "", text)
    text = re.sub(r"[\s]+", "-", text.strip())
    text = re.sub(r"-{2,}", "-", text)
    return text[:max_len].rstrip("-") or "untitled"


def safe_write(dest: Path, content: str) -> str:
    if dest.exists():
        return "skipped"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(content, encoding="utf-8")
    return "written"


def relative_subfolder(html_file: Path, export_root: Path) -> Path:
    """Return the sub-path from export root to html_file's parent."""
    try:
        rel = html_file.parent.relative_to(export_root)
    except ValueError:
        rel = Path()
    return rel


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Migrate OneNote HTML export to Obsidian Inbox")
    parser.add_argument("--export", required=True, help="Path to OneNote export folder")
    parser.add_argument("--out",    required=True, help="Path to vault Inbox/ directory")
    parser.add_argument("--json",   action="store_true", help="Output JSON summary")
    args = parser.parse_args()

    export_path = Path(args.export).expanduser()
    out_path    = Path(args.out).expanduser()

    if not export_path.exists() or not export_path.is_dir():
        print(f"error: export folder not found: {export_path}", file=sys.stderr)
        sys.exit(1)

    html_files = list(export_path.rglob("*.html")) + list(export_path.rglob("*.htm"))
    if not html_files:
        print(f"error: no HTML files found in {export_path}", file=sys.stderr)
        sys.exit(1)

    migrated, skipped, failed = 0, 0, 0
    files_out: list[str] = []

    for html_file in sorted(html_files):
        try:
            html = html_file.read_text(encoding="utf-8", errors="replace")
            title, body = html_to_markdown(html)
            if not title:
                title = html_file.stem

            slug = slugify(title)
            subfolder = relative_subfolder(html_file, export_path)
            dest_dir = out_path / subfolder
            dest = dest_dir / f"{slug}.md"

            fm = (
                f"---\ntype: inbox\nsource: onenote\ntitle: \"{title}\"\n"
                f"imported: {date.today().isoformat()}\n---\n\n"
            )
            content = fm + body + "\n"

            result = safe_write(dest, content)
            if result == "written":
                migrated += 1
                files_out.append(str(dest))
            else:
                skipped += 1

        except Exception as e:
            print(f"  failed: {html_file.name} — {e}", file=sys.stderr)
            failed += 1

    if args.json:
        print(json.dumps({"migrated": migrated, "skipped": skipped, "failed": failed, "files": files_out}))
    else:
        print(f"Migrated {migrated} notes, skipped {skipped} (already exist), failed {failed}")


if __name__ == "__main__":
    main()
