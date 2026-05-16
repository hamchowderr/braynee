#!/usr/bin/env python3
"""
Backfill structured session summaries from Claude Code .jsonl transcripts
into the vault's per-project Sessions folder.

Reads each CC session JSONL, filters out tool-call noise, sends the
conversation skeleton to Claude API, and writes a structured summary
matching the brainy session-note format.

Idempotent: skips sessions whose target note already exists.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

import subprocess

# anthropic SDK is OPTIONAL — only needed if --use-api is passed. Default mode
# shells out to `claude -p` and uses the local Claude Code subscription.
try:
    import anthropic  # type: ignore
except ImportError:
    anthropic = None  # type: ignore


# ── Paths ─────────────────────────────────────────────────────────────────
VAULT = Path.home() / "Obsidian Vault"
CC_PROJECTS = Path.home() / ".claude" / "projects"
SESSIONS_DIR = VAULT / "2. Areas" / "Sessions"
SCRIPT_DIR = Path(__file__).resolve().parent
MAP_FILE = SCRIPT_DIR / "project_map.json"

CC_PREFIX = "C--Users-HamCh-code-"

# Sessions shorter than this many filtered chars are skipped as trivial.
MIN_FILTERED_CHARS = 400

# Cap on input length sent to the API (chars). Sonnet's window is huge,
# but ~80KB filtered conversation is plenty of signal for a summary.
MAX_INPUT_CHARS = 80_000


# ── Project name resolution ───────────────────────────────────────────────
def load_overrides() -> dict[str, str]:
    if not MAP_FILE.exists():
        return {}
    try:
        data = json.loads(MAP_FILE.read_text(encoding="utf-8"))
        return {k: v for k, v in data.items() if not k.startswith("_")}
    except Exception:
        return {}


OVERRIDES = load_overrides()


SPECIAL_DIRS = {
    "C--Users-HamCh-Obsidian-Vault": "_vault",
    "C--Users-HamCh": "_home",
    "C--Users-HamCh-Obsidian-Vault-1--Projects": "_vault-projects",
    "C--Users-HamCh-code": "_code",
    "C--FXServer-txData-FiveMBasicServerCFXDefault-B89B02-base-resources--local-": "_fxserver",
}


def cc_dir_to_kebab(cc_dir_name: str) -> str:
    """`C--Users-HamCh-code-sophon-webapp` → `sophon-webapp`"""
    if cc_dir_name in SPECIAL_DIRS:
        return SPECIAL_DIRS[cc_dir_name]
    if cc_dir_name.startswith(CC_PREFIX):
        return cc_dir_name[len(CC_PREFIX):]
    return cc_dir_name


def kebab_to_wikilink(kebab: str) -> str:
    """`sophon-webapp` → `Sophon Webapp` (Title Case With Spaces)"""
    if kebab in OVERRIDES:
        return OVERRIDES[kebab]
    return " ".join(w.capitalize() for w in kebab.split("-"))


def kebab_to_folder(kebab: str) -> str:
    """`sophon-webapp` → `Sophon-Webapp` (Title-Kebab; matches existing vault convention)"""
    if kebab in OVERRIDES:
        # Convert wikilink form back to folder form (spaces → dashes)
        return OVERRIDES[kebab].replace(" ", "-")
    return "-".join(w.capitalize() for w in kebab.split("-"))


# ── JSONL filtering ───────────────────────────────────────────────────────
NOISE_PREFIXES = (
    "<local-command",
    "<command-name",
    "<command-message",
    "<system-reminder",
    "Caveat:",
    "[Request interrupted",
)


def filter_jsonl(jsonl_path: Path) -> str:
    """Read a CC .jsonl and return user/assistant text only, no tool noise."""
    out: list[str] = []
    try:
        for line in jsonl_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if not line.strip():
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue

            t = d.get("type")
            msg = d.get("message", {}) or {}
            content = msg.get("content", "")

            if t == "user":
                if isinstance(content, str):
                    if any(content.lstrip().startswith(p) for p in NOISE_PREFIXES):
                        continue
                    text = content.strip()
                    if text:
                        out.append("USER: " + text[:2000])
                elif isinstance(content, list):
                    for blk in content:
                        if isinstance(blk, dict) and blk.get("type") == "text":
                            text = (blk.get("text") or "").strip()
                            if text and not any(text.startswith(p) for p in NOISE_PREFIXES):
                                out.append("USER: " + text[:2000])

            elif t == "assistant":
                if isinstance(content, list):
                    for blk in content:
                        if isinstance(blk, dict) and blk.get("type") == "text":
                            text = (blk.get("text") or "").strip()
                            if text:
                                out.append("ASST: " + text[:2000])
    except Exception as e:
        sys.stderr.write(f"  filter error on {jsonl_path.name}: {e}\n")

    return "\n\n".join(out)


# ── Classification ────────────────────────────────────────────────────────
def classify_session_type(filtered: str) -> str:
    """Heuristic: pick a session_type tag from conversation content."""
    text = filtered.lower()
    debug_signals = ("debug", " bug", "error", "fail", "root cause", "stack trace", "broken")
    plan_signals = ("plan", "roadmap", "architecture", "design doc", "rfc")
    research_signals = ("research", "explore", "compare", "evaluate", "investigate")
    review_signals = ("review", "audit", "feedback on")

    counts = {
        "debug": sum(text.count(s) for s in debug_signals),
        "plan": sum(text.count(s) for s in plan_signals),
        "research": sum(text.count(s) for s in research_signals),
        "review": sum(text.count(s) for s in review_signals),
    }
    best = max(counts.items(), key=lambda kv: kv[1])
    return best[0] if best[1] >= 3 else "code"


# ── System prompt for distillation ────────────────────────────────────────
SYSTEM_PROMPT = """You are summarizing a Claude Code session transcript into a structured Obsidian note.

The transcript is a series of USER: and ASST: lines (the human user and the AI assistant). Tool-call noise has been stripped.

Output ONLY the markdown body (no YAML frontmatter — that is added separately). Use this exact structure with these exact section headers:

## TL;DR
[1-2 sentences. State of the work and the outcome. Plain language. This is the first thing both humans and agents see — make it dense with specifics: project names, file names, what shipped or what's stuck.]

## Goal
[What this session was trying to accomplish. One sentence. Anchored on what the USER actually asked for, not what got done.]

## Outcome
- **Shipped:** concrete changes that landed (a file edit, a deploy, a merge, a decision recorded, a doc written). If nothing shipped, write `_(nothing — investigation only)_` or similar.
- **In flight:** work started but not finished. If nothing, write `_(none)_`.

## Decisions
- **[Decision]** — rationale, and what alternatives were considered if any. If no architectural choices were made, write `_(none — [reason])_`.

## Blockers / Open Questions
- [Things stuck, waiting on someone, or unknown — the items that need answering before the next session]. If none, write `_(none)_`.

## Next
[The single highest-leverage next action. Concrete and specific — name files, functions, commands. Not "continue working on X."]

## References
- **Files:** specific `path/to/file.ts` references with line numbers if mentioned
- **Related:** [[wikilinks]] to projects, clients, PRDs, related notes if mentioned

RULES:
1. Be SPECIFIC. Name files, functions, services, libraries, dates, error messages. Avoid vague summaries.
2. Never invent content. If a section is legitimately empty, mark it `_(none — [why])_`.
3. Total length: 150-300 words. Density beats verbosity.
4. The TL;DR must include the project name and the operative noun (what was worked on) — this is the primary search anchor."""


# ── Distillation backends ─────────────────────────────────────────────────
import tempfile


def distill_via_cli(filtered: str) -> str:
    """Call `claude -p` — uses the user's CC subscription OAuth, no API credits.

    IMPORTANT: ANTHROPIC_API_KEY is stripped from the subprocess env. If the
    var is set, `claude -p` will use it (API billing) instead of OAuth.

    Passes:
      - system prompt via --append-system-prompt-file (avoids cmdline limit)
      - user message via stdin (avoids Windows ~32KB cmdline cap)
    """
    payload = filtered[:MAX_INPUT_CHARS]
    user_msg = f"Session transcript:\n\n{payload}"
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}

    # System prompt to a temp file — keeps it off the cmdline.
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=False) as sf:
        sf.write(SYSTEM_PROMPT)
        sys_path = sf.name

    try:
        result = subprocess.run(
            [
                "claude", "-p",
                "--append-system-prompt-file", sys_path,
            ],
            input=user_msg,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=900,
            env=env,
        )
    finally:
        try:
            os.unlink(sys_path)
        except OSError:
            pass

    if result.returncode != 0 or "Credit balance is too low" in result.stdout:
        err = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"claude -p failed: {err[:500]}")
    return result.stdout.strip()


def distill_via_api(client, filtered: str, model: str = "claude-sonnet-4-6") -> str:
    """Call the raw Anthropic API — costs Console credits. Off by default."""
    if anthropic is None:
        raise RuntimeError("anthropic SDK not installed (pip install anthropic)")
    payload = filtered[:MAX_INPUT_CHARS]
    resp = client.messages.create(
        model=model,
        max_tokens=2000,
        system=[
            {
                "type": "text",
                "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[
            {
                "role": "user",
                "content": f"Session transcript:\n\n{payload}",
            }
        ],
    )
    return resp.content[0].text.strip()


# ── Note rendering ────────────────────────────────────────────────────────
def render_note(
    project_wikilink: str,
    session_type: str,
    session_id: str,
    started_iso: str,
    body: str,
) -> str:
    fm = (
        "---\n"
        "type: session\n"
        f'project: "[[{project_wikilink}]]"\n'
        "status: done\n"
        f"session_type: {session_type}\n"
        f'session_id: "{session_id}"\n'
        f"started: {started_iso}\n"
        "tags:\n"
        "  - session\n"
        f"  - {session_type}\n"
        "---\n\n"
    )
    return fm + body + "\n"


# ── Existing-note detection ───────────────────────────────────────────────
def existing_note_for_session(folder: Path, session_id: str) -> Path | None:
    if not folder.exists():
        return None
    for note in folder.glob("*.md"):
        try:
            head = note.read_text(encoding="utf-8", errors="ignore")[:1000]
        except Exception:
            continue
        if session_id in head:
            return note
    return None


# ── Per-session backfill ──────────────────────────────────────────────────
def backfill_one(
    jsonl_path: Path,
    client,
    *,
    dry_run: bool = False,
    model: str = "claude-sonnet-4-6",
    use_api: bool = False,
) -> str:
    cc_dir = jsonl_path.parent.name
    kebab = cc_dir_to_kebab(cc_dir)
    project_wikilink = kebab_to_wikilink(kebab)
    folder_name = kebab_to_folder(kebab)

    folder = SESSIONS_DIR / folder_name
    session_id = jsonl_path.stem

    existing = existing_note_for_session(folder, session_id)
    if existing is not None:
        return f"EXISTS: {existing.relative_to(VAULT)}"

    filtered = filter_jsonl(jsonl_path)
    if len(filtered) < MIN_FILTERED_CHARS:
        return f"SKIP (trivial, {len(filtered)} chars): {jsonl_path.name}"

    mtime = datetime.fromtimestamp(jsonl_path.stat().st_mtime)
    date_str = mtime.strftime("%Y-%m-%d")
    session_type = classify_session_type(filtered)
    note_name = f"{date_str}-{kebab}-{session_type}-{session_id[:8]}.md"
    target = folder / note_name

    if dry_run:
        return f"WOULD CREATE: {target.relative_to(VAULT)} (filtered {len(filtered)} chars, type={session_type})"

    if use_api:
        body = distill_via_api(client, filtered, model=model)
    else:
        body = distill_via_cli(filtered)
    note = render_note(
        project_wikilink=project_wikilink,
        session_type=session_type,
        session_id=session_id,
        started_iso=mtime.isoformat() + "Z",
        body=body,
    )
    folder.mkdir(parents=True, exist_ok=True)
    target.write_text(note, encoding="utf-8")
    return f"CREATED: {target.relative_to(VAULT)}"


# ── Entry ─────────────────────────────────────────────────────────────────
def iter_target_dirs(project: str | None, all_flag: bool) -> list[Path]:
    if project:
        for cc_name, alias in SPECIAL_DIRS.items():
            if project == alias:
                return [CC_PROJECTS / cc_name]
        return [CC_PROJECTS / f"{CC_PREFIX}{project}"]
    if all_flag:
        return sorted(
            [d for d in CC_PROJECTS.iterdir() if d.is_dir()
             and (d.name.startswith(CC_PREFIX) or d.name in SPECIAL_DIRS)],
            key=lambda d: d.name,
        )
    return []


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project", help="CC project folder kebab name (e.g., sophon-webapp)")
    ap.add_argument("--all", action="store_true", help="Backfill every CC project")
    ap.add_argument("--limit", type=int, default=0, help="Cap on sessions per project (0 = unlimited)")
    ap.add_argument("--dry-run", action="store_true", help="Show what would be created without calling the API")
    ap.add_argument("--model", default="claude-sonnet-4-6", help="Claude model id (only used with --use-api)")
    ap.add_argument("--use-api", action="store_true", help="Use the Anthropic API directly (costs Console credits). Default is `claude -p` (uses your CC subscription).")
    args = ap.parse_args()

    if not args.project and not args.all:
        ap.error("provide --project NAME or --all")

    client = None
    if args.use_api and not args.dry_run:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            sys.stderr.write("--use-api requires ANTHROPIC_API_KEY in env.\n")
            return 1
        if anthropic is None:
            sys.stderr.write("--use-api requires `pip install anthropic`.\n")
            return 1
        client = anthropic.Anthropic()

    dirs = iter_target_dirs(args.project, args.all)
    if not dirs:
        sys.stderr.write("No CC project directories matched.\n")
        return 1

    stats = {"created": 0, "exists": 0, "trivial": 0, "would_create": 0, "errors": 0}

    for d in dirs:
        if not d.exists():
            print(f"NOT FOUND: {d.name}")
            continue
        jsonls = sorted(d.glob("*.jsonl"), key=lambda f: f.stat().st_mtime, reverse=True)
        if args.limit:
            jsonls = jsonls[: args.limit]
        if not jsonls:
            continue

        print(f"\n=== {d.name} ({len(jsonls)} sessions) ===")
        for j in jsonls:
            try:
                msg = backfill_one(j, client, dry_run=args.dry_run, model=args.model, use_api=args.use_api)
            except Exception as e:
                msg = f"ERROR: {j.name}: {e}"
                stats["errors"] += 1
            else:
                if msg.startswith("CREATED"):
                    stats["created"] += 1
                elif msg.startswith("EXISTS"):
                    stats["exists"] += 1
                elif msg.startswith("SKIP"):
                    stats["trivial"] += 1
                elif msg.startswith("WOULD"):
                    stats["would_create"] += 1
            print(f"  {msg}", flush=True)

    print("\n=== Summary ===")
    for k, v in stats.items():
        print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
