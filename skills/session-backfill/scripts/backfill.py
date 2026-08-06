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
import re
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


# The numbered PARA folders braynee scaffolds. Their presence marks a braynee
# vault even without a `.obsidian/` dir (non-Obsidian markdown apps have none).
_PARA_MARKERS = ("1. Projects", "2. Areas", "3. Resources", "4. Archives")


def _is_braynee_vault(p: Path) -> bool:
    """A dir is a braynee vault if Obsidian marks it OR it carries the PARA
    skeleton (>=2 numbered folders). Host-agnostic so Logseq/Foam/Dendron/
    Shockwave/plain-folder vaults are detected too. Mirrors isBrayneeVault in
    scripts/lib/vault-root.js."""
    try:
        if (p / ".obsidian").is_dir():
            return True
    except OSError:
        pass
    hits = 0
    for m in _PARA_MARKERS:
        try:
            if (p / m).is_dir():
                hits += 1
        except OSError:
            pass
    return hits >= 2


def find_vault(explicit: str | None = None) -> Path | None:
    """Resolve the braynee vault universally.

    Priority: --vault arg → $BRAYNEE_VAULT → $OBSIDIAN_VAULT → common
    locations that are a braynee vault (`.obsidian/` OR the PARA skeleton).
    $BRAYNEE_VAULT is the canonical opt-in for a vault at a non-standard path
    (e.g. a non-Obsidian markdown app). Mirrors the resolution used by
    scripts/lib/vault-root.js so behaviour is consistent for every user.
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
        HOME / "Documents" / "Notes",
        HOME / "Notes",
        HOME / "OneDrive" / "Obsidian Vault",
        HOME / "iCloud Drive" / "Obsidian Vault",
    ]
    for candidate in candidates:
        if _is_braynee_vault(candidate):
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


def _override_entry(kebab: str):
    """Raw override value for a kebab (or just its last segment), or None. A
    value is EITHER a plain string (the wikilink; folder derived from it) OR an
    object with optional 'wikilink' and 'folder' keys — the object form lets a
    user pin the [[link]] and the exact Sessions/ folder INDEPENDENTLY, e.g. an
    old project name (`old-codename`) that should fold into its renamed
    successor's existing folder (`sophon-webapp`) while linking
    `[[Sophon Webapp]]`."""
    if kebab in OVERRIDES:
        return OVERRIDES[kebab]
    last = kebab.split("-")[-1]
    if last in OVERRIDES:
        return OVERRIDES[last]
    return None


def _override_wikilink(kebab: str) -> str | None:
    v = _override_entry(kebab)
    if isinstance(v, str):
        return v
    if isinstance(v, dict):
        return v.get("wikilink") or v.get("folder")
    return None


def _override_folder(kebab: str) -> str | None:
    v = _override_entry(kebab)
    if isinstance(v, dict):
        return v.get("folder")
    return None


def kebab_to_wikilink(kebab: str) -> str:
    """`sophon-webapp` → `Sophon Webapp` (Title Case With Spaces); a project_map
    override wins (string value, or the 'wikilink' key of an object value)."""
    wl = _override_wikilink(kebab)
    if wl:
        return wl
    return " ".join(w.capitalize() for w in kebab.split("-") if w)


def kebab_to_folder(kebab: str) -> str:
    """`sophon-webapp` → `Sophon-Webapp` (Title-Kebab; vault convention)."""
    return kebab_to_wikilink(kebab).replace(" ", "-")


def resolve_project_folder(sessions_dir: Path, kebab: str) -> Path:
    """Return the Sessions/ subfolder new notes should land in — preferring an
    EXISTING folder over the computed name, so a backfill consolidates into the
    folder a project's notes already live in rather than spawning a case-variant
    twin. The real hook wrote folders inconsistently over time (lowercase
    `sophon-webapp/` vs Title-Kebab `Sophon-Webapp/`); matching case-insensitively
    against both the raw kebab and the Title-Kebab form heals that drift.
    Falls back to the Title-Kebab name only when no folder exists yet. A
    project_map override with an explicit 'folder' wins outright — it routes a
    project into a specific folder (e.g. fold an old name into its successor, or
    park non-project cwd sessions in a named bucket), preferring the existing
    folder of that name if present."""
    forced = _override_folder(kebab)
    if forced:
        if sessions_dir.exists():
            for d in sessions_dir.iterdir():
                if d.is_dir() and d.name.lower() == forced.lower():
                    return d
        return sessions_dir / forced
    computed = kebab_to_folder(kebab)
    wanted = {kebab.lower(), computed.lower()}
    if sessions_dir.exists():
        best = None
        best_count = -1
        for d in sessions_dir.iterdir():
            if not d.is_dir() or d.name.lower() not in wanted:
                continue
            # If both a lowercase and Title-Kebab twin exist, prefer the one
            # holding more notes (the canonical home).
            count = sum(1 for _ in d.glob("*.md"))
            if count > best_count:
                best, best_count = d, count
        if best is not None:
            return best
    return sessions_dir / computed


# ── JSONL filtering ───────────────────────────────────────────────────────
# Opening lines of the two user messages this script sends to `claude -p` (see
# distill_via_cli: the normal prompt, and the retry nudge when the first reply
# fails validation). Shared so the filtering below can never drift from the
# prompts it is meant to recognize.
DISTILL_PROMPT_PREFIX = "Session transcript:"
DISTILL_RETRY_PREFIX = "You previously responded with tool calls"

NOISE_PREFIXES = (
    "<local-command",
    "<command-name",
    "<command-message",
    "<system-reminder",
    "Caveat:",
    "[Request interrupted",
    # Our OWN distillation prompt. Every `claude -p` call is recorded by CC as a
    # user message, and those land in two places: standalone sessions under
    # whatever cwd the sweep ran from, AND injected into real interactive
    # sessions open in that cwd at the time. Left in, they get re-distilled and
    # compound: one transcript had accumulated 492 copies of the prompt by
    # 2026-08-05, and the summary ends up describing the summarizer, not the work.
    DISTILL_PROMPT_PREFIX,
    DISTILL_RETRY_PREFIX,
)

_TOOLCALL_RE = re.compile(
    r"<function_calls>.*?</function_calls>"
    r"|</?function_calls>"
    r"|<invoke\b.*?</invoke>"
    r"|</?invoke\b[^>]*>"
    r"|<parameter\b.*?</parameter>"
    r"|</?parameter\b[^>]*>"
    r"|antml:\w+",
    re.DOTALL,
)


def _strip_toolcall_syntax(text: str) -> str:
    """Remove tool-call / function-call markup embedded in a transcript's text.
    Older session formats rendered tool calls INTO the assistant text; if that
    reaches the distiller it mimics the syntax and emits junk instead of a
    summary (observed 2026-07-02). Strip it so the model only ever sees prose."""
    if not any(s in text for s in ("<function_calls", "<invoke", "<parameter", "antml:")):
        return text
    cleaned = _TOOLCALL_RE.sub(" ", text)
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


def session_cwd(jsonl_path: Path) -> Path | None:
    """The working directory Claude Code recorded for this session.

    Read from the transcript, never inferred from the CC folder name — that
    name encodes the path with `-` for every separator, so it cannot be decoded
    back reliably (a real folder like `myrp-build` is indistinguishable from a
    nested `myrp/build`).
    """
    try:
        for line in jsonl_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(rec, dict) and rec.get("cwd"):
                return Path(rec["cwd"])
    except Exception:
        pass
    return None


def is_scratch_session(jsonl_path: Path) -> bool:
    """True if this session ran in a throwaway directory.

    Sessions started from the OS temp dir are not project work — they are
    sandboxes, scratch checkouts, and tooling that the OS itself will delete.
    Summarising them buried the vault under hundreds of notes about nothing
    (one temp bucket reached 1,260 sessions).

    Asking the OS where temp lives keeps this self-maintaining: a hand-written
    list of folder names would need a new entry for every future sandbox, and
    would misfire on real projects whose names merely contain "temp"
    (alchemist-template, chatgpt-app-templates).

    Deliberately NOT keyed on "is it a git repo" — several real projects here
    are not repos (fivem-studio, mastra-lab) and would be lost.
    """
    cwd = session_cwd(jsonl_path)
    if cwd is None:
        return False                       # unknown — treat as real, never drop blind
    try:
        tmp = Path(tempfile.gettempdir()).resolve()
        return tmp == cwd.resolve() or tmp in cwd.resolve().parents
    except Exception:
        return False


def is_vault_session(jsonl_path: Path, vault: Path) -> bool:
    """True if this session ran inside the vault itself.

    Working in the vault is note-keeping, not project work, and the live
    SessionStart hook already refuses to open a session note for it — it tells
    the user "a session note will be created when you start work on a
    recognized project" (hooks/session-auto-track.js, vault mode).

    This script never got that rule, so a historical backfill manufactured the
    very notes the hook declines to write: 509 vault-root sessions, plus 239
    more from `1. Projects`. Matching the hook makes the two agree instead of
    one quietly undoing the other.
    """
    cwd = session_cwd(jsonl_path)
    if cwd is None or vault is None:
        return False
    try:
        c, v = cwd.resolve(), vault.resolve()
        return c == v or v in c.parents
    except Exception:
        return False


def iter_turns(jsonl_path: Path):
    """Yield (role, text) for each real conversation turn, tool noise removed.

    Roles are read from the JSONL's own message type, never inferred from the
    rendered text — a distilled summary can quote "USER:"/"ASST:" markers in its
    body, so callers that need to know whether a *human* spoke must consult the
    role here rather than pattern-match filter_jsonl's output.
    """
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
                    text = _strip_toolcall_syntax(content.strip())
                    if text:
                        yield "user", text[:2000]
                elif isinstance(content, list):
                    for blk in content:
                        if isinstance(blk, dict) and blk.get("type") == "text":
                            text = (blk.get("text") or "").strip()
                            if text and not any(text.startswith(p) for p in NOISE_PREFIXES):
                                text = _strip_toolcall_syntax(text)
                                if text:
                                    yield "user", text[:2000]

            elif t == "assistant":
                if isinstance(content, list):
                    for blk in content:
                        if isinstance(blk, dict) and blk.get("type") == "text":
                            text = _strip_toolcall_syntax((blk.get("text") or "").strip())
                            if text:
                                yield "assistant", text[:2000]
    except Exception as e:
        sys.stderr.write(f"  filter error on {jsonl_path.name}: {e}\n")


def filter_jsonl(jsonl_path: Path) -> str:
    """Read a CC .jsonl and return user/assistant text only, no tool noise."""
    label = {"user": "USER: ", "assistant": "ASST: "}
    return "\n\n".join(label[role] + text for role, text in iter_turns(jsonl_path))


def has_human_turn(jsonl_path: Path) -> bool:
    """True if any genuine user message survived noise filtering."""
    return any(role == "user" for role, _ in iter_turns(jsonl_path))


def is_backfill_artifact(jsonl_path: Path) -> bool:
    """True if this session is NOTHING BUT our own `claude -p` distillation calls.

    Every distillation is recorded by CC as a session of its own, which the next
    scan then treats as fresh backlog — so each run manufactured more work than
    it cleared and the backlog never converged (913 pending, ~111 real, observed
    2026-08-05).

    The test: NOISE_PREFIXES already strips the distiller's prompts, so if no
    user turn survives and the raw file carries one of those prompts, the
    session was purely our own exhaust.

    Both halves are load-bearing. In an artifact the only user turn IS the
    prompt, and what remains is the assistant's summary — substantial prose, so
    a length check reads it as real work. Conversely a sweep spawned from a
    project's cwd pollutes the *real* interactive session open there; those
    carry distiller prompts AND genuine user turns, and must still be distilled
    from the cleaned text. Judging on raw text alone (e.g. "starts with the
    prompt") discarded 138 genuine foreman sessions in testing.

    Detection is CONTENT-based rather than a folder blocklist because artifacts
    scatter across whichever cwd the sweep ran from, and real project folders
    are MIXED — foreman held 138 polluted-but-real sessions among 188.
    """
    if has_human_turn(jsonl_path):
        return False  # a human actually said something — real session
    raw = _safe_read(jsonl_path)
    return DISTILL_PROMPT_PREFIX in raw or DISTILL_RETRY_PREFIX in raw


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
- **Commits:** every git SHA that appears, with its message (e.g. `9f402ce` — wire shadcn registry). If none, `_(none)_`.
- **Beads:** every beads issue ID that appears (e.g. `skate-gis`, `cp-qoya`), each marked closed / opened / referenced. If none, `_(none)_`.
- **Related:** [[wikilinks]] to projects, clients, PRDs, related notes if mentioned

RULES:
1. Be SPECIFIC. Name files, functions, services, libraries, dates, error messages. Avoid vague summaries.
2. Never invent content. If a section is legitimately empty, mark it `_(none — [why])_`.
3. Total length: 150-300 words. Density beats verbosity.
4. The TL;DR must include the project name and the operative noun (what was worked on) — this is the primary search anchor.
5. MANDATORY — capture every git commit SHA and every beads issue ID that appears, verbatim, in the References section. These are the only durable links from this summary back to the code history and the task tracker, and the raw transcript is NOT kept in the vault, so an ID omitted here is lost from the vault permanently. Copy them exactly; never paraphrase, abbreviate, or invent one.
5. You are summarizing a COMPLETED, PAST transcript. You are NOT in that session and cannot act. Do NOT continue the work, run searches, read files, or offer to help. Do NOT emit tool calls or any `<function_calls>` / `<invoke ...>` / `antml:` syntax. Do NOT ask the user anything. Your ENTIRE output is the static markdown summary beginning with `## TL;DR` — nothing before it, nothing after `## References`."""


# ── Distillation backends ─────────────────────────────────────────────────
class DistillationInvalid(Exception):
    """The distiller returned something that is not a clean summary — the model
    role-played the session (emitted tool-call syntax / offered to do work) or
    dropped the required structure. Raised so the caller SKIPS writing rather
    than persisting garbage as a note body."""


# Signatures of a distiller that acted as an agent instead of summarizing. Any
# of these in the output means the model leaked its own tool-call/continuation
# behavior into what should be a static summary — observed ~1% of the time on
# transcripts that were themselves about doing agentic work.
AGENTIC_MARKERS = (
    "<function_calls",
    "<invoke name=",
    "antml:",
    "Session note saved to the vault",
    "I'll write the session summary",
    "</parameter>",
)


def _distillation_problem(text: str) -> str | None:
    """None if the output is a clean summary; otherwise a short reason string.
    Guards against the two observed failure modes: (a) the model emitting
    tool-call syntax / continuing the session, and (b) missing the required
    section structure."""
    if not text or len(text.strip()) < 80:
        return "empty/too short"
    for m in AGENTIC_MARKERS:
        if m in text:
            return f"agentic leak {m!r}"
    if "## TL;DR" not in text or "## Outcome" not in text:
        return "missing required sections"
    # The raw transcript is NOT retained in the vault, so these two lines are
    # the only durable links from a summary back to the code history and the
    # task tracker. A summary that drops them silently loses that trail, so
    # treat their absence as a failed distillation and retry rather than
    # writing a note that can never be traced back. `_(none)_` is a valid
    # value — the requirement is that the model answered, not that IDs exist.
    if "**Commits:**" not in text or "**Beads:**" not in text:
        return "missing Commits/Beads references"
    return None


def distill_via_cli(filtered: str, model: str | None = None) -> str:
    """Call `claude -p` — uses the user's CC subscription OAuth, no API credits.

    IMPORTANT: ANTHROPIC_API_KEY is stripped from the subprocess env. If the
    var is set, `claude -p` would otherwise use it (API billing) instead of
    the OAuth subscription. We never want to silently bill API credits.

    `model` (optional, e.g. "sonnet"/"haiku") picks the model. Summarizing a
    transcript does not need the biggest model, so the caller can force a
    cheaper/faster one — important for large historical backfills. Without it,
    `claude -p` uses the user's configured default (which may be the priciest).

    Runs in a NEUTRAL temp cwd so the spawned `claude -p` can never trip
    braynee's own SessionStart/Stop hooks — those only act inside a code repo
    or the vault, so a temp dir makes them no-op and we never stamp a spurious
    session note for wherever the sweep happened to be invoked.

    Passes:
      - system prompt via --append-system-prompt-file (off the cmdline, so
        no OS argument-length limits)
      - user message via stdin (avoids the Windows ~32KB cmdline cap)
    """
    payload = filtered[:MAX_INPUT_CHARS]
    base_msg = f"{DISTILL_PROMPT_PREFIX}\n\n{payload}"
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}

    # System prompt to a temp file — keeps it off the cmdline (length limits).
    sf = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", suffix=".txt", delete=False
    )
    try:
        sf.write(SYSTEM_PROMPT)
        sf.close()
        sys_path = sf.name

        # Run TOOL-FREE. This is a pure text transformation, but `claude -p` is
        # otherwise a full agent that will grab the Write tool and save the
        # summary to a file of its own naming instead of printing it (observed
        # 2026-07-02). An empty --tools unloads all tools so the model can only
        # emit text to stdout, which is what we capture as the note body.
        cmd = ["claude", "-p", "--tools", "", "--append-system-prompt-file", sys_path]
        if model:
            cmd += ["--model", model]

        # Even tool-free, the model occasionally role-plays continuing the
        # session (emits tool-call syntax as text) instead of summarizing.
        # Validate the output; on failure retry ONCE with a firmer nudge, then
        # give up (raise) so the caller skips writing rather than persist junk.
        last_problem = "no output"
        for attempt in range(2):
            user_msg = base_msg if attempt == 0 else (
                DISTILL_RETRY_PREFIX + " or by continuing the "
                "session. That is wrong. Re-read the rules: output ONLY the "
                "static markdown summary starting at `## TL;DR`. No tool calls, "
                "no offers to help, no questions.\n\n" + base_msg
            )
            result = subprocess.run(
                cmd,
                input=user_msg,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=900,
                env=env,
                cwd=tempfile.gettempdir(),
            )
            if result.returncode != 0 or "Credit balance is too low" in (result.stdout or ""):
                err = (result.stderr or "").strip() or (result.stdout or "").strip()
                raise RuntimeError(f"claude -p failed: {err[:500]}")
            out = (result.stdout or "").strip()
            problem = _distillation_problem(out)
            if problem is None:
                return out
            last_problem = problem
    finally:
        try:
            os.unlink(sf.name)
        except OSError:
            pass

    raise DistillationInvalid(last_problem)


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
    out = resp.content[0].text.strip()
    problem = _distillation_problem(out)
    if problem is not None:
        raise DistillationInvalid(problem)
    return out


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


# ── Existing-note detection & stub upgrade ────────────────────────────────
# The distiller's signature sections. A note that has BOTH (and no stub
# placeholder) is already a real summary and must never be clobbered.
DISTILLED_MARKERS = ("## TL;DR", "## Outcome")

# Placeholder strings UNIQUE to the session-auto-track stub template. The
# distiller writes `_(none — reason)_` (underscored), never these, so they are
# safe positive signals that a note is a hollow stub to upgrade. (Do NOT use a
# bare "(none)" here — the distiller's `_(none)_` would match it as a substring.)
STUB_MARKERS = (
    "(session just started)",
    "(Waiting for user to state goal",
    "(none yet)",
)


def note_is_distilled(content: str) -> bool:
    """True if the note already carries a real distillation: both signature
    sections present and no stub placeholders. Anything else (a hollow stub,
    a corrupted note, a half-written note) is treated as upgradeable."""
    if not all(m in content for m in DISTILLED_MARKERS):
        return False
    return not any(m in content for m in STUB_MARKERS)


def _safe_read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


def build_sid_index(sessions_dir: Path) -> dict:
    """One pass over every Sessions note -> {session_id: Path}. A full backfill
    resolves thousands of sessions; doing an rglob per session is O(N*M) over a
    4000+ note tree. Building the index once makes the whole run O(N+M). The stub
    writer and distiller can disagree on which project folder a session lands in,
    so the index spans ALL folders (skips the raw Transcripts tree)."""
    idx: dict[str, Path] = {}
    if not sessions_dir.exists():
        return idx
    for note in sessions_dir.rglob("*.md"):
        if "Transcripts" in note.parts:
            continue
        head = _safe_read(note)[:1500]
        if not head:
            continue
        m = re.search(r'(?m)^session_id:\s*"?([^\s"\n]+)"?', head)
        if not m:
            continue
        sid = m.group(1)
        prior = idx.get(sid)
        # First writer wins, but prefer a real distillation over a stub if a
        # duplicate ever exists — keeps the index self-healing.
        if prior is None:
            idx[sid] = note
        elif not note_is_distilled(_safe_read(prior)) and note_is_distilled(_safe_read(note)):
            idx[sid] = note
    return idx


def gc_hollow_stubs(folder: Path, dry_run: bool) -> list[Path]:
    """Delete content-free PRE-FIX stubs (hollow placeholder body + no session_id)
    from a single project folder. Once create-fresh has distilled the real
    session from its JSONL, these orphans carry ZERO information by definition
    (only '(session just started)'-style placeholders), so removing them loses
    nothing and de-clutters the timeline. Deliberately conservative — a note is
    GC-eligible ONLY if ALL hold: (1) no session_id (a post-fix note is
    identifiable and never touched), (2) a stub placeholder marker is present,
    (3) it is NOT a real distillation. Anything ambiguous is kept."""
    victims: list[Path] = []
    if not folder.exists():
        return victims
    for note in sorted(folder.glob("*.md")):
        c = _safe_read(note)
        if not c:
            continue
        if re.search(r'(?m)^session_id:', c[:1500]):
            continue  # identifiable / post-fix — never GC
        if not any(m in c for m in STUB_MARKERS):
            continue  # has real content — keep
        if all(m in c for m in DISTILLED_MARKERS):
            continue  # somehow distilled — keep
        victims.append(note)
        if not dry_run:
            try:
                note.unlink()
            except Exception as e:
                sys.stderr.write(f"  gc unlink failed {note.name}: {e}\n")
    return victims


def upgrade_note(existing_content: str, new_body: str, session_id: str | None = None) -> str:
    """Replace a stub note's body with the distilled body while preserving the
    existing YAML frontmatter (it carries the accurate started/ended/branch/
    session_id state). Flip status:active -> done. If `session_id` is given and
    the stub has none (a legacy adoption), stamp it so the note is identifiable
    and never adopted/duplicated again."""
    m = re.match(r"^(---\n.*?\n---\n)", existing_content, re.DOTALL)
    fm = m.group(1) if m else ""
    fm = re.sub(r"(?m)^status:\s*active\s*$", "status: done", fm)
    if session_id and not re.search(r"(?m)^session_id:", fm):
        fm = fm.replace("---\n", f'---\nsession_id: "{session_id}"\n', 1)
    return fm.rstrip("\n") + "\n\n" + new_body + "\n"


# ── Per-session backfill ──────────────────────────────────────────────────
def backfill_one(
    jsonl_path: Path,
    client,
    sessions_dir: Path,
    vault: Path,
    sid_index: dict,
    *,
    dry_run: bool = False,
    model: str = "claude-sonnet-4-6",
    cli_model: str = "sonnet",
    use_api: bool = False,
) -> str:
    cc_dir = jsonl_path.parent.name
    kebab = cc_dir_to_kebab(cc_dir)
    project_wikilink = kebab_to_wikilink(kebab)

    # Prefer the folder this project's notes already live in (heals the
    # lowercase vs Title-Kebab folder drift the live hook left behind).
    folder = resolve_project_folder(sessions_dir, kebab)
    session_id = jsonl_path.stem

    # Resolve this session's note by session_id via the prebuilt index (spans
    # ALL folders, so folder drift can't hide it). If it's already a real
    # distillation, we're done. If it's a stub carrying a session_id, upgrade it
    # in place. A PRE-FIX hollow stub (no session_id) can't be matched here — we
    # create a fresh note from the JSONL (the source of truth) and the GC pass
    # sweeps the emptied stub afterward.
    existing = sid_index.get(session_id)
    upgrade_target = None
    existing_content = ""
    adopt_sid = None
    if existing is not None:
        existing_content = _safe_read(existing)
        if note_is_distilled(existing_content):
            try:
                rel = existing.relative_to(vault)
            except ValueError:
                rel = existing
            return f"EXISTS: {rel}"
        upgrade_target = existing  # a stub (with session_id) — overwrite in place

    filtered = filter_jsonl(jsonl_path)
    if is_scratch_session(jsonl_path):
        return f"SKIP (scratch dir): {jsonl_path.name}"
    if is_vault_session(jsonl_path, vault):
        return f"SKIP (vault session): {jsonl_path.name}"
    if is_backfill_artifact(jsonl_path):
        return f"SKIP (backfill artifact): {jsonl_path.name}"
    if len(filtered) < MIN_FILTERED_CHARS:
        return f"SKIP (trivial, {len(filtered)} chars): {jsonl_path.name}"

    mtime = datetime.fromtimestamp(jsonl_path.stat().st_mtime)
    date_str = mtime.strftime("%Y-%m-%d")
    session_type = classify_session_type(filtered)

    if upgrade_target is not None:
        try:
            rel_up = upgrade_target.relative_to(vault)
        except ValueError:
            rel_up = upgrade_target
        if dry_run:
            return (
                f"WOULD UPGRADE: {rel_up} "
                f"(filtered {len(filtered)} chars, type={session_type})"
            )
    else:
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

    # The distiller occasionally role-plays the session instead of summarizing.
    # It self-validates + retries; if it still can't produce a clean summary we
    # SKIP writing rather than persist junk — the stub/absence is preferable to
    # a corrupt note, and the session can be retried later.
    try:
        if use_api:
            body = distill_via_api(client, filtered, model=model)
        else:
            body = distill_via_cli(filtered, model=cli_model)
    except DistillationInvalid as e:
        return f"SKIP (distill invalid: {e}): {jsonl_path.name}"

    # Upgrade a stub in place — preserve its frontmatter, swap the hollow body.
    # adopt_sid is set only for a legacy stub with no session_id, so the upgrade
    # stamps one on (identifiable + never re-adopted).
    if upgrade_target is not None:
        upgrade_target.write_text(
            upgrade_note(existing_content, body, session_id=adopt_sid), encoding="utf-8"
        )
        return f"UPGRADED: {rel_up}"

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
        "--cli-model",
        default="sonnet",
        help="Model for the default `claude -p` path (alias: sonnet/haiku/opus). "
        "Summaries don't need the biggest model — default 'sonnet' keeps quota "
        "and time down, which matters on large historical backfills.",
    )
    ap.add_argument(
        "--use-api",
        action="store_true",
        help="Use the Anthropic API directly (costs Console credits / needs ANTHROPIC_API_KEY). "
        "Default is `claude -p`, which uses your Claude Code subscription with no API billing.",
    )
    ap.add_argument(
        "--gc-stubs",
        action="store_true",
        help="After distilling, delete content-free PRE-FIX hollow stubs (no "
        "session_id + placeholder body) from each processed project folder. The "
        "create-fresh pass has already reconstructed the real session from its "
        "JSONL, so these orphans carry zero information. Pair with --dry-run "
        "first to preview exactly what would be deleted.",
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

    stats = {"created": 0, "upgraded": 0, "exists": 0, "trivial": 0, "would_create": 0,
             "would_upgrade": 0, "distill_invalid": 0, "artifact": 0,
             "scratch": 0, "vault_session": 0, "gc_deleted": 0, "gc_would_delete": 0, "errors": 0}

    # Build the session_id -> note index ONCE (spans all folders). A full
    # backfill resolves thousands of sessions; a per-session rglob would be
    # O(sessions * notes) over a 4000+ note tree.
    print("Indexing existing session notes…", flush=True)
    sid_index = build_sid_index(sessions_dir)
    print(f"  indexed {len(sid_index)} notes with a session_id", flush=True)

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
                    j, client, sessions_dir, vault, sid_index,
                    dry_run=args.dry_run, model=args.model,
                    cli_model=args.cli_model, use_api=args.use_api,
                )
            except Exception as e:
                msg = f"ERROR: {j.name}: {e}"
                stats["errors"] += 1
            else:
                if msg.startswith("CREATED"):
                    stats["created"] += 1
                elif msg.startswith("UPGRADED"):
                    stats["upgraded"] += 1
                elif msg.startswith("EXISTS"):
                    stats["exists"] += 1
                elif msg.startswith("SKIP (distill invalid"):
                    stats["distill_invalid"] += 1
                elif msg.startswith("SKIP (backfill artifact"):
                    stats["artifact"] += 1
                elif msg.startswith("SKIP (scratch dir"):
                    stats["scratch"] += 1
                elif msg.startswith("SKIP (vault session"):
                    stats["vault_session"] += 1
                elif msg.startswith("SKIP"):
                    stats["trivial"] += 1
                elif msg.startswith("WOULD UPGRADE"):
                    stats["would_upgrade"] += 1
                elif msg.startswith("WOULD"):
                    stats["would_create"] += 1
            print(f"  {msg}", flush=True)

        # GC pass — sweep this project's folder for content-free pre-fix stubs
        # that create-fresh has now superseded. Scoped to the folder the
        # project's notes actually live in (drift-healed).
        if args.gc_stubs:
            kebab = cc_dir_to_kebab(d.name)
            folder = resolve_project_folder(sessions_dir, kebab)
            victims = gc_hollow_stubs(folder, dry_run=args.dry_run)
            verb = "WOULD DELETE" if args.dry_run else "DELETED"
            print(f"  --- GC: {verb} {len(victims)} hollow stub(s) in {folder.name}/ ---", flush=True)
            for v in victims[:40]:
                print(f"      {verb}: {v.name}")
            if len(victims) > 40:
                print(f"      … and {len(victims) - 40} more")
            stats["gc_would_delete" if args.dry_run else "gc_deleted"] += len(victims)

    print("\n=== Summary ===")
    for k, v in stats.items():
        print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
