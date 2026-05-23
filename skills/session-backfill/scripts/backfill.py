#!/usr/bin/env python3
"""
Backfill structured session summaries from Claude Code .jsonl transcripts
into the vault's per-project Sessions folder.

Reads each CC session JSONL, filters out tool-call noise, distills the
conversation into a structured summary matching the braynee session-note
format, and writes it to `2. Areas/Sessions/<Project>/<note>.md`.

Distillation uses `claude -p` by default — the local Claude Code OAuth
subscription, NO API credits and NO API key required. `--use-api` opts
into the raw Anthropic API (Console billing) only if the user asks for it.

Universal: no hardcoded user, OS, or code-directory paths. Works wherever
the vault and `~/.claude/projects/` live, on Windows / macOS / Linux.

Idempotent: skips sessions whose target note already exists.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
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
HOME = Path.home()
CC_PROJECTS = HOME / ".claude" / "projects"
SCRIPT_DIR = Path(__file__).resolve().parent
MAP_FILE = SCRIPT_DIR / "project_map.json"


def find_vault(explicit: str | None = None) -> Path | None:
    """Resolve the Obsidian vault universally.

    Priority: --vault arg → $BRAYNEE_VAULT → $OBSIDIAN_VAULT → common
    locations probed for a `.obsidian` directory. Mirrors the resolution
    used by braynee's sessions / setup skills so behaviour is consistent
    for every user regardless of where their vault lives.
    """
    if explicit:
        p = Path(explicit).expanduser()
        return p if p.is_dir() else None

    for env_var in ("BRAYNEE_VAULT", "OBSIDIAN_VAULT"):
        val = os.environ.get(env_var)
        if val:
            p = Path(val).expanduser()
            if p.is_dir():
                return p

    candidates = [
        HOME / "Obsidian Vault",
        HOME / "vault",
        HOME / "ObsidianVault",
        HOME / "Documents" / "Obsidian Vault",
        HOME / "Documents" / "vault",
        HOME / "OneDrive" / "Obsidian Vault",
        HOME / "iCloud Drive" / "Obsidian Vault",
    ]
    for candidate in candidates:
        if (candidate / ".obsidian").is_dir():
            return candidate
    # Last resort: the conventional default even without .obsidian, so a
    # brand-new vault still works.
    return HOME / "Obsidian Vault"


# Sessions shorter than this many filtered chars are skipped as trivial.
MIN_FILTERED_CHARS = 400

# Cap on input length sent to the model (chars). The context window is huge,
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

# Common parent-directory tokens. When a CC folder encodes
# .../<parent>/<project>, the project is the segment AFTER the last of
# these. This is a heuristic only — overrides win, and a wrong guess just
# yields a slightly longer slug, never data loss.
PARENT_TOKENS = {
    "code", "src", "repos", "repo", "work", "projects", "project",
    "dev", "git", "workspace", "sources", "developer", "documents",
}


def cc_dir_to_kebab(cc_dir_name: str) -> str:
    """Derive a project slug from a Claude Code project folder name.

    CC encodes the project's absolute path by replacing every path
    separator (and the Windows drive colon) with ``-``. Examples:

      C:\\Users\\jane\\code\\my-app   -> C--Users-jane-code-my-app
      /home/jane/work/my-app          -> -home-jane-work-my-app
      /Users/jane/dev/api-server      -> -Users-jane-dev-api-server

    There is no portable way to recover original casing or to know how
    many trailing ``-`` belong to the dir name vs. were separators. The
    universal heuristic: split on ``-``, drop empty tokens and a leading
    one-letter Windows drive letter, then take everything AFTER the last
    recognised parent token (``code``/``src``/``work``/...). If no parent
    token is present, fall back to the last token. project_map.json
    overrides handle anything that needs a nicer wikilink.
    """
    raw = (cc_dir_name or "").strip("-")
    if not raw:
        return cc_dir_name or "unknown"

    parts = [p for p in raw.split("-") if p != ""]
    if not parts:
        return cc_dir_name or "unknown"

    # Drop a leading single-letter Windows drive token (C, D, ...).
    if len(parts) > 1 and len(parts[0]) == 1 and parts[0].isalpha():
        parts = parts[1:]

    # Find the last parent token; the project is everything after it.
    last_parent = -1
    for i, tok in enumerate(parts):
        if tok.lower() in PARENT_TOKENS:
            last_parent = i
    if last_parent >= 0 and last_parent < len(parts) - 1:
        project_parts = parts[last_parent + 1:]
    else:
        # No parent token (or it's the final token) — use the last token.
        project_parts = [parts[-1]]

    slug = "-".join(project_parts)
    return slug or (cc_dir_name or "unknown")


def kebab_to_wikilink(kebab: str) -> str:
    """`sophon-webapp` → `Sophon Webapp` (Title Case With Spaces)."""
    if kebab in OVERRIDES:
        return OVERRIDES[kebab]
    # Override may also key on just the last segment.
    last = kebab.split("-")[-1]
    if last in OVERRIDES:
        return OVERRIDES[last]
    return " ".join(w.capitalize() for w in kebab.split("-") if w)


def kebab_to_folder(kebab: str) -> str:
    """`sophon-webapp` → `Sophon-Webapp` (Title-Kebab; vault convention)."""
    return kebab_to_wikilink(kebab).replace(" ", "-")


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
def distill_via_cli(filtered: str) -> str:
    """Call `claude -p` — uses the user's CC subscription OAuth, no API credits.

    IMPORTANT: ANTHROPIC_API_KEY is stripped from the subprocess env. If the
    var is set, `claude -p` would otherwise use it (API billing) instead of
    the OAuth subscription. We never want to silently bill API credits.

    Passes:
      - system prompt via --append-system-prompt-file (off the cmdline, so
        no OS argument-length limits)
      - user message via stdin (avoids the Windows ~32KB cmdline cap)
    """
    payload = filtered[:MAX_INPUT_CHARS]
    user_msg = f"Session transcript:\n\n{payload}"
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}

    # System prompt to a temp file — keeps it off the cmdline (length limits).
    sf = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", suffix=".txt", delete=False
    )
    try:
        sf.write(SYSTEM_PROMPT)
        sf.close()
        sys_path = sf.name

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
            os.unlink(sf.name)
        except OSError:
            pass

    if result.returncode != 0 or "Credit balance is too low" in (result.stdout or ""):
        err = (result.stderr or "").strip() or (result.stdout or "").strip()
        raise RuntimeError(f"claude -p failed: {err[:500]}")
    return (result.stdout or "").strip()


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
    sessions_dir: Path,
    vault: Path,
    *,
    dry_run: bool = False,
    model: str = "claude-sonnet-4-6",
    use_api: bool = False,
) -> str:
    cc_dir = jsonl_path.parent.name
    kebab = cc_dir_to_kebab(cc_dir)
    project_wikilink = kebab_to_wikilink(kebab)
    folder_name = kebab_to_folder(kebab)

    folder = sessions_dir / folder_name
    session_id = jsonl_path.stem

    existing = existing_note_for_session(folder, session_id)
    if existing is not None:
        try:
            rel = existing.relative_to(vault)
        except ValueError:
            rel = existing
        return f"EXISTS: {rel}"

    filtered = filter_jsonl(jsonl_path)
    if len(filtered) < MIN_FILTERED_CHARS:
        return f"SKIP (trivial, {len(filtered)} chars): {jsonl_path.name}"

    mtime = datetime.fromtimestamp(jsonl_path.stat().st_mtime)
    date_str = mtime.strftime("%Y-%m-%d")
    session_type = classify_session_type(filtered)
    note_name = f"{date_str}-{kebab}-{session_type}-{session_id[:8]}.md"
    target = folder / note_name

    try:
        rel_target = target.relative_to(vault)
    except ValueError:
        rel_target = target

    if dry_run:
        return (
            f"WOULD CREATE: {rel_target} "
            f"(filtered {len(filtered)} chars, type={session_type})"
        )

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
    return f"CREATED: {rel_target}"


# ── Entry ─────────────────────────────────────────────────────────────────
def iter_target_dirs(project: str | None, all_flag: bool) -> list[Path]:
    """Resolve which CC project directories to process.

    --project matches generically: a directory qualifies if its derived
    project slug equals the requested name, or if its CC folder name ends
    with the requested token. No hardcoded prefixes or per-user aliases.
    """
    if not CC_PROJECTS.is_dir():
        return []
    all_dirs = sorted(
        [d for d in CC_PROJECTS.iterdir() if d.is_dir()],
        key=lambda d: d.name,
    )
    if project:
        want = project.strip().lower()
        matched = [
            d for d in all_dirs
            if cc_dir_to_kebab(d.name).lower() == want
            or d.name.lower().endswith(want)
            or d.name.lower().endswith("-" + want)
        ]
        return matched
    if all_flag:
        return all_dirs
    return []


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project", help="Project name / CC folder suffix (e.g., sophon-webapp)")
    ap.add_argument("--all", action="store_true", help="Backfill every CC project")
    ap.add_argument("--limit", type=int, default=0, help="Cap on sessions per project (0 = unlimited)")
    ap.add_argument(
        "--since-hours",
        type=float,
        default=0.0,
        help="Only process sessions whose .jsonl was modified within the last N "
        "hours (0 = no time filter). Used by the auto-summary sweep to stay "
        "incremental; manual full backfills omit it.",
    )
    ap.add_argument(
        "--min-age-minutes",
        type=float,
        default=0.0,
        help="Skip sessions whose .jsonl was modified within the last N minutes "
        "(0 = no guard). A still-open session has a fresh mtime; summarizing it "
        "would lock in a premature 'done' note (backfill is idempotent). The "
        "auto-sweep sets this so only settled sessions are distilled.",
    )
    ap.add_argument("--dry-run", action="store_true", help="Show what would be created without distilling")
    ap.add_argument("--vault", help="Vault path (auto-detected via $BRAYNEE_VAULT / common locations if omitted)")
    ap.add_argument("--model", default="claude-sonnet-4-6", help="Claude model id (only used with --use-api)")
    ap.add_argument(
        "--use-api",
        action="store_true",
        help="Use the Anthropic API directly (costs Console credits / needs ANTHROPIC_API_KEY). "
        "Default is `claude -p`, which uses your Claude Code subscription with no API billing.",
    )
    args = ap.parse_args()

    if not args.project and not args.all:
        ap.error("provide --project NAME or --all")

    vault = find_vault(args.vault)
    if vault is None:
        sys.stderr.write(
            "Obsidian vault not found. Set $BRAYNEE_VAULT or pass --vault PATH.\n"
        )
        return 1
    sessions_dir = vault / "2. Areas" / "Sessions"

    client = None
    if args.use_api and not args.dry_run:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            sys.stderr.write(
                "--use-api requires ANTHROPIC_API_KEY in env. Either export it "
                "yourself, or drop --use-api to use `claude -p` (no API billing).\n"
            )
            return 1
        if anthropic is None:
            sys.stderr.write("--use-api requires `pip install anthropic`.\n")
            return 1
        client = anthropic.Anthropic()

    dirs = iter_target_dirs(args.project, args.all)
    if not dirs:
        sys.stderr.write(
            f"No CC project directories matched under {CC_PROJECTS}.\n"
        )
        return 1

    stats = {"created": 0, "exists": 0, "trivial": 0, "would_create": 0, "errors": 0}

    for d in dirs:
        if not d.exists():
            print(f"NOT FOUND: {d.name}")
            continue
        jsonls = sorted(d.glob("*.jsonl"), key=lambda f: f.stat().st_mtime, reverse=True)
        if args.since_hours and args.since_hours > 0:
            cutoff = datetime.now().timestamp() - args.since_hours * 3600
            jsonls = [j for j in jsonls if j.stat().st_mtime >= cutoff]
        if args.min_age_minutes and args.min_age_minutes > 0:
            settled = datetime.now().timestamp() - args.min_age_minutes * 60
            jsonls = [j for j in jsonls if j.stat().st_mtime <= settled]
        if args.limit:
            jsonls = jsonls[: args.limit]
        if not jsonls:
            continue

        print(f"\n=== {d.name} ({len(jsonls)} sessions) ===")
        for j in jsonls:
            try:
                msg = backfill_one(
                    j, client, sessions_dir, vault,
                    dry_run=args.dry_run, model=args.model, use_api=args.use_api,
                )
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
