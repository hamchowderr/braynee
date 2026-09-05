#!/usr/bin/env python3
"""
Brain Check — Setup, Connections, Beads, Memory, Inbox.
"""

import os
import re
import sys
import json
sys.stdout.reconfigure(encoding="utf-8")
import argparse
import subprocess
import shutil
from pathlib import Path
from datetime import date, timedelta, datetime


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


def check_tool(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def ok(label: str):
    print(f"  ✓  {label}")


def warn(label: str):
    print(f"  ✗  {label}")


def report_qmd_index(status: str):
    """Report what `qmd status` actually says about the index.

    The check used to read the exit code and throw the output away, so it said
    "installed" while the index quietly drifted. Every number below is one that
    had to be dug out by hand at least once: a vault that stopped being indexed,
    an embed backlog that never drained, and 26k orphaned vector chunks — half
    the vector rows — that nothing ever reclaimed.
    """
    docs = re.search(r"Total:\s+(\d+)\s+files indexed", status)
    vecs = re.search(r"Vectors:\s+(\d+)\s+embedded", status)
    if docs and vecs:
        print(f"  ·  qmd index: {int(docs.group(1)):,} documents, {int(vecs.group(1)):,} vectors")

    # "Updated: 8m ago" / "3h ago" / "2d ago". Only days are worth a warning:
    # the reindex runs on session Stop, so hours are normal between sessions.
    updated = re.search(r"Updated:\s+(\d+)([smhd])\s+ago", status)
    if updated:
        amount, unit = int(updated.group(1)), updated.group(2)
        if unit == "d":
            warn(f"qmd index last updated {amount}d ago — the Stop-hook reindex may be failing")
        else:
            ok(f"qmd index updated {amount}{unit} ago")

    # qmd omits the Pending line entirely at zero.
    pending = re.search(r"Pending:\s+(\d+)\s+need embedding", status)
    if pending:
        n = int(pending.group(1))
        # 200 is braynee's own backlog escape hatch (see hooks/lib/qmd-reindex.js).
        (warn if n >= 200 else ok)(
            f"qmd embeddings: {n:,} pending"
            + (" — semantic search is missing recent notes; run `qmd embed`" if n >= 200 else "")
        )

    orphaned = re.search(r"Orphaned:\s+(\d+)\s+embedding chunks \((\d+)%\)", status)
    if orphaned:
        warn(f"qmd index: {int(orphaned.group(1)):,} orphaned vector chunks "
             f"({orphaned.group(2)}% of rows) — run `qmd cleanup`")


def run_version(cmd: list[str], timeout: int = 5) -> str | None:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if r.returncode == 0:
            return r.stdout.strip().splitlines()[0] if r.stdout.strip() else "(ok)"
        return None
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None


def cmd_check(args, vault: Path):
    print("\n── Brain Check ─────────────────────────────────────────────\n")
    cmd_setup(args, vault)
    print()
    cmd_connections(args, vault)
    print()
    cmd_beads(args, vault)
    print()
    cmd_memory(args, vault)
    print()
    cmd_inbox(args, vault)
    print()


def cmd_setup(args, vault: Path):
    print("Setup — Tools and scripts installed?\n")

    tool_checks = [
        (["git", "--version"],        "git — version control"),
        (["node", "--version"],       "node — Node.js runtime"),
        (["python3", "--version"],    "python3 — Python runtime"),
        (["bd", "version"],           "bd — Beads issue tracker"),
        (["curl", "--version"],       "curl — HTTP client"),
    ]
    for cmd_args, label in tool_checks:
        version = run_version(cmd_args)
        if version:
            ok(f"{label} ({version})")
        else:
            warn(f"{label} — NOT FOUND")

    # Obsidian CLI is OPTIONAL — braynee's write-path skills fall back to direct
    # fs writes when it's absent, so a non-Obsidian markdown app is fully
    # supported. Report absence as info, never a failure.
    obs = run_version(["obsidian", "--version"])
    if obs:
        ok(f"obsidian — CLI ({obs})")
    else:
        print("  ·  obsidian — CLI: not present (fs-write fallback active)")

    # health.py lives at braynee/skills/health/scripts/health.py
    # qmd-wrapper.mjs is at braynee/scripts/qmd-wrapper.mjs (3 levels up)
    qmd_wrapper = Path(__file__).resolve().parent.parent.parent.parent / "scripts" / "qmd-wrapper.mjs"
    if not qmd_wrapper.exists():
        warn(f"qmd — wrapper not found at {qmd_wrapper}")
    else:
        # `qmd status` counts documents and vectors across the whole index and
        # gets slower as it grows — 46s has been measured on a 1.4 GB index. The
        # old 10s cap with no except raised TimeoutExpired and crashed the very
        # command you run to find out the index is unhealthy.
        status = None
        try:
            r = subprocess.run(
                ["node", str(qmd_wrapper), "status"],
                capture_output=True, text=True, timeout=120
            )
            status = r.stdout if r.returncode == 0 else None
        except (subprocess.TimeoutExpired, OSError):
            status = None
        if status is None:
            warn("qmd — status did not answer (index busy, or the CLI is broken)")
        else:
            ok("qmd — search engine (installed)")
            report_qmd_index(status)

    # Ship-stage CLIs — needed only for the autonomous-ship engine (CI / deploy /
    # secrets / behavioral verify). OPTIONAL: a vault-only or local-only user doesn't
    # need these, so a miss prints an install hint rather than a hard ✗ (cp-7do).
    print()
    print("  Ship-stage CLIs (autonomous-ship engine — optional):")
    ship_clis = [
        (["gh", "--version"],            "gh — GitHub CLI (PRs, gh:run/gh:pr gates)",  "winget install GitHub.cli · brew install gh"),
        (["dolt", "version"],            "dolt — beads Dolt backend",                  "winget install DoltHub.Dolt · github.com/dolthub/dolt/releases"),
        (["infisical", "--version"],     "infisical — secret injection",               "npm i -g @infisical/cli · brew install infisical/get-cli/infisical"),
        (["clerk", "--version"],         "clerk — Clerk auth CLI",                     "see clerk.com/docs (CLI is optional)"),
        (["supabase", "--version"],      "supabase — Supabase CLI",                    "brew install supabase/tap/supabase · scoop install supabase"),
        (["vercel", "--version"],        "vercel — Vercel deploy CLI",                 "npm i -g vercel"),
        (["agent-browser", "--version"], "agent-browser — headless browser verify",    "npm i -g agent-browser"),
        (["docker", "--version"],        "docker — containers (coolify-docker target)", "docs.docker.com/get-docker"),
    ]
    for cmd_args, label, hint in ship_clis:
        # Presence via shutil.which (respects PATHEXT, so it finds Windows npm .cmd
        # shims like agent-browser.cmd that subprocess can't exec directly); version
        # is best-effort (None for a .cmd shim → just report it's installed).
        if check_tool(cmd_args[0]):
            version = run_version(cmd_args)
            ok(f"{label} ({version})" if version else f"{label} (installed)")
        else:
            print(f"  ·  {label} — not installed · install: {hint}")
    print("  (Global CLIs above are invoked directly by agents; project-scoped tools run via the project's own runner — never guess the invocation.)")

    # Braynee ships its hooks INSIDE the plugin and registers them in the
    # plugin's own hooks/hooks.json. The standalone install put copies in
    # ~/.claude/hooks with entries in ~/.claude/settings.json. Either satisfies
    # the check. Looking only at the legacy pair reported every plugin user's
    # working hooks as missing — including the Stop hook that reindexes the
    # vault — and a health report that cries wolf is one people stop reading.
    plugin_hooks_dir = Path(__file__).resolve().parent.parent.parent.parent / "hooks"
    plugin_hooks_json = plugin_hooks_dir / "hooks.json"
    plugin_hooks_text = (
        plugin_hooks_json.read_text(encoding="utf-8") if plugin_hooks_json.exists() else ""
    )
    legacy_hooks_dir = Path.home() / ".claude" / "hooks"
    for hook in ["vault-context-prime.js", "session-auto-track.js", "session-export-qmd.js", "statusline-state.js"]:
        if (plugin_hooks_dir / hook).exists() and hook in plugin_hooks_text:
            ok(f"hook: {hook} (plugin)")
        elif (legacy_hooks_dir / hook).exists():
            ok(f"hook: {hook} (~/.claude/hooks)")
        else:
            warn(f"hook: {hook} — not registered in the plugin, and absent from {legacy_hooks_dir}")

    settings_path = Path.home() / ".claude" / "settings.json"
    if settings_path.exists():
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
        all_cmds = [
            h.get("command", "")
            for entries in settings.get("hooks", {}).values()
            for e in entries for h in e.get("hooks", [])
        ]
        for feature, term in [
            ("vault_context", "vault-context-prime"),
            ("session_tracking", "session-auto-track"),
            ("qmd_sync", "session-export-qmd"),
        ]:
            # Registered in the plugin's hooks.json counts: that is where a
            # plugin install declares them, and settings.json stays empty.
            if term in plugin_hooks_text:
                ok(f"settings: {feature} hook registered (plugin)")
            elif any(term in c for c in all_cmds):
                ok(f"settings: {feature} hook registered (settings.json)")
            else:
                warn(f"settings: {feature} hook NOT registered")
    else:
        warn("settings.json not found")

    plugin_root = Path(__file__).parent.parent.parent
    for skill in ["setup", "daily", "tasks", "recap",
                  "sessions", "clients", "query", "health", "zettelkasten", "settings-viewer"]:
        skill_md = plugin_root / skill / "SKILL.md"
        if skill_md.exists():
            ok(f"skill: {skill}")
        else:
            warn(f"skill: {skill} — SKILL.md missing")


def cmd_connections(args, vault: Path):
    print("Connections — Live integrations reachable?\n")

    if check_tool("bd"):
        ok("Beads (bd) available")
    else:
        warn("Beads (bd) not found")

    if check_tool("obsidian"):
        ok("obsidian CLI available")
    else:
        print("  ·  obsidian CLI not present (fs-write fallback active)")

    qmd_wrapper = Path.home() / ".claude" / "scripts" / "qmd-wrapper.mjs"
    if qmd_wrapper.exists():
        result = subprocess.run(
            ["node", str(qmd_wrapper), "status", "--json"],
            capture_output=True, text=True, timeout=10
        )
        try:
            s = json.loads(result.stdout)
            collections = s.get("collections", [])
            doc_count = sum(c.get("documents", 0) for c in collections)
            last_indexed = max((c.get("lastIndexed", 0) for c in collections), default=0)
            if last_indexed:
                last_dt = datetime.fromtimestamp(last_indexed / 1000)
                age_hours = (datetime.now() - last_dt).total_seconds() / 3600
                age_str = f"{int(age_hours)}h ago" if age_hours < 48 else f"{int(age_hours/24)}d ago"
                if age_hours > 48:
                    warn(f"QMD index stale: {doc_count} docs, last indexed {age_str}")
                else:
                    ok(f"QMD index: {doc_count} docs, indexed {age_str}")
            else:
                ok(f"QMD index: {doc_count} docs")
        except (json.JSONDecodeError, KeyError):
            ok("QMD installed (run `qmd status` for details)")
    else:
        warn("QMD wrapper not found")


def cmd_beads(args, vault: Path):
    print("Beads — Repo tracker healthy + no secrets committed?\n")

    if not check_tool("bd"):
        warn("Beads (bd) not found — skipping bd doctor")
        return

    # bd doctor is repo-scoped: only meaningful inside a beads repo (cwd has .beads/).
    if not Path(".beads").is_dir():
        ok("Not a beads repo here (no .beads/ in cwd) — nothing to check")
        return

    try:
        # Decode as UTF-8: bd doctor's ✓/⚠/✖ markers must survive so the secret
        # filter below matches (the default Windows codec would mangle them).
        r = subprocess.run(
            ["bd", "doctor"], capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=60,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        warn("bd doctor did not run (bd missing or timed out)")
        return

    lines = ((r.stdout or "") + (r.stderr or "")).splitlines()

    m = re.search(r"(\d+)\s+passed.*?(\d+)\s+warning.*?(\d+)\s+error", " ".join(lines))
    if m:
        print(f"  ·  bd doctor: {m.group(1)} passed, {m.group(2)} warnings, {m.group(3)} errors")

    # SECURITY-CRITICAL: a committed credential key / tracked secret / gitignore drift is
    # exactly what let .beads-credential-key get published. Surface it loudly.
    SECRET_KEYS = ("credential", "tracked runtime", "sensitive data", "secret", "gitignore", ".env")
    secret_hits = [
        l.strip() for l in lines
        if any(k in l.lower() for k in SECRET_KEYS) and ("✖" in l or "⚠" in l)
    ]
    if secret_hits:
        warn("bd doctor flagged secret / gitignore drift — fix BEFORE any publish:")
        for l in secret_hits[:8]:
            print(f"        {l}")
        print("        → gitignore + `git rm --cached` the file(s). See bd memory "
              "`tracker-content-public-vs-private`.")
    elif m and int(m.group(3)) > 0:
        # Non-secret errors exist (e.g. repo-fingerprint) — note them, less urgent.
        errs = [l.strip() for l in lines if "✖" in l and "passed" not in l]
        for l in errs[:4]:
            warn(l)
    else:
        ok("bd doctor: no tracked secrets, gitignore current")

    # ── Traceability hygiene (cp-ci9.3) ──────────────────────────────────────
    # Surface issue-QUALITY drift, not just secrets — the same checks the
    # beads-auditor agent runs: missing sections, implemented-but-still-open
    # (`bd orphans`), stale, and whether the create-time validation guard is on.
    def _bd(*bd_args):
        try:
            return subprocess.run(
                ["bd", *bd_args], capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=30,
            ).stdout or ""
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return ""

    missing = sum(1 for l in _bd("lint").splitlines() if "Missing:" in l)
    om = re.search(r"(\d+)\s+orphaned", _bd("orphans"))
    orphans = int(om.group(1)) if om else 0
    sm = re.search(r"(\d+)\s+stale", _bd("stale"))
    stale = int(sm.group(1)) if sm else 0
    guard_lines = [l.strip() for l in _bd("config", "get", "validation.on-create").splitlines() if l.strip()]
    guard_val = guard_lines[-1] if guard_lines else "unset"

    print(f"  ·  traceability: {missing} missing-section · {orphans} open-but-landed · {stale} stale · guard={guard_val}")
    if missing:
        warn(f"{missing} issue(s) missing required sections — run beads-auditor or `bd lint`")
    if guard_val not in ("warn", "error", "strict"):
        warn("create-time guard off — `bd config set validation.on-create warn`")
    if not missing and guard_val in ("warn", "error", "strict"):
        ok(f"traceability: sections complete, guard={guard_val}")


def cmd_memory(args, vault: Path):
    print("Memory — Is Claude loaded with current context?\n")

    claude_md = vault / "CLAUDE.md"
    if claude_md.exists():
        age = (date.today() - date.fromtimestamp(claude_md.stat().st_mtime)).days
        if age > 30:
            warn(f"Vault CLAUDE.md last modified {age} days ago — may be stale")
        else:
            ok(f"Vault CLAUDE.md current ({age}d ago)")
    else:
        warn("CLAUDE.md missing from vault root")

    global_claude_md = Path.home() / ".claude" / "CLAUDE.md"
    if global_claude_md.exists():
        age = (date.today() - date.fromtimestamp(global_claude_md.stat().st_mtime)).days
        if age > 30:
            warn(f"Global CLAUDE.md last modified {age} days ago — may be stale")
        else:
            ok(f"Global CLAUDE.md current ({age}d ago)")
    else:
        warn("~/.claude/CLAUDE.md missing")

    context_dir = vault / "2. Areas" / "context"
    for fname in ["about-me.md", "about-business.md", "priorities.md"]:
        p = context_dir / fname
        if p.exists():
            ok(fname)
        else:
            warn(f"{fname} missing (create in 2. Areas/context/)")

    memory_dir = vault / "2. Areas" / "Claude Memory"
    if memory_dir.exists():
        count = len(list(memory_dir.glob("*.md")))
        ok(f"Claude Memory — vault ({count} entries)")
        # MEMORY.md tripwire: CC auto-loads only the first 200 lines / 25KB of
        # MEMORY.md at session start. Warn before the index crosses the cap so it
        # never silently truncates (cp-1nl). 22KB leaves headroom below ~24.4KB.
        #
        # The advice used to say "run /health or trigger a memory resync", which
        # was doubly wrong (cp-ccsh.4 / B3): /braynee:health does not resync, and
        # before cp-ccsh.2 a resync bounded only the description, so it REBUILT
        # the folder at 26,404 bytes — the recommended remedy was the cause. With
        # the whole-line budget in place a resync now measurably shrinks the index
        # (26,404 -> 19,614 bytes on the 126-note folder), so name the action that
        # actually triggers one plus the lever that shrinks it further.
        #
        # OVERLAP WITH CLAUDE CODE, resolved deliberately (cp-hdpr.3) — do not
        # delete this check as "redundant" without reading this first. CC now
        # covers the same condition twice:
        #   - 2.1.186 reminds the AGENT to compact the index when nearing the cap.
        #   - 2.1.210 makes a memory write that leaves the index over its read
        #     limit an explicit ERROR instead of silent truncation.
        # Both fire at WRITE time and speak to the agent. This check fires at
        # AUDIT time (`/braynee:health`), speaks to the HUMAN, and is the only one
        # of the three that names the specific lever — which frontmatter field to
        # shorten, and where to retire stale entries. Complementary, not
        # duplicative, so it stays. Note also that post-cp-ccsh.2 braynee's own
        # resync cannot produce an over-cap file, so CC's 2.1.210 error should
        # never be reachable from braynee's write path; if it ever fires, that is
        # a real regression in memory-index.js, not a user problem.
        memory_index = memory_dir / "MEMORY.md"
        if memory_index.exists():
            kb = memory_index.stat().st_size / 1024
            if kb >= 22:
                warn(
                    f"MEMORY.md is {kb:.1f}KB — approaching CC's 25KB startup-load "
                    f"cap. Save any edit to MEMORY.md: that fires the resync hook, "
                    f"which rebuilds the index under a 150-char whole-line budget. "
                    f"If it stays large, shorten the longest name: and description: "
                    f"frontmatter in '2. Areas/Claude Memory/' — a long name: is "
                    f"what pushes a line over — and retire stale entries to "
                    f"ARCHIVED.md"
                )
            else:
                ok(f"MEMORY.md index {kb:.1f}KB (under 25KB load cap)")
    else:
        warn("Claude Memory directory missing")

    # Claude Code auto memory: ~/.claude/projects/<project>/memory/
    projects_dir = Path.home() / ".claude" / "projects"
    if projects_dir.exists():
        auto_memory_dirs = [
            p for p in projects_dir.iterdir()
            if p.is_dir() and (p / "memory" / "MEMORY.md").exists()
        ]
        if auto_memory_dirs:
            for amd in auto_memory_dirs:
                mem_md = amd / "memory" / "MEMORY.md"
                lines = len(mem_md.read_text(encoding="utf-8").splitlines())
                ok(f"Auto memory — {amd.name[:40]} ({lines} lines)")
        else:
            warn("Auto memory — no project memory directories found")


def cmd_inbox(args, vault: Path):
    print("Inbox — What's backed up or unprocessed?\n")

    inbox = vault / "Inbox"
    if inbox.exists():
        items = len(list(inbox.glob("*.md")))
        if items == 0:
            ok("Inbox: empty")
        elif items <= 5:
            warn(f"Inbox: {items} items waiting")
        else:
            warn(f"Inbox: {items} items — process soon")
    else:
        warn("Inbox folder not found")

    sessions_dir = vault / "2. Areas" / "Sessions"
    if sessions_dir.exists():
        week_ago = date.today() - timedelta(days=7)
        recent = [
            f for f in sessions_dir.rglob("*.md")
            if date.fromtimestamp(f.stat().st_mtime) >= week_ago
        ]
        if recent:
            ok(f"Sessions: {len(recent)} synced this week")
        else:
            warn("Sessions: none synced this week")

    settings_path = Path.home() / ".claude" / "settings.json"
    if settings_path.exists():
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
        all_cmds = [
            h.get("command", "")
            for entries in settings.get("hooks", {}).values()
            for e in entries for h in e.get("hooks", [])
        ]
        if not any("session-tracker" in c for c in all_cmds):
            warn("Session tracker hook not registered — sessions may not be auto-syncing")


def main():
    parser = argparse.ArgumentParser(description="Brain Check — Braynee system health")
    parser.add_argument("--vault", help="Vault path (auto-detected if omitted)")
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("check")
    sub.add_parser("setup")
    sub.add_parser("connections")
    sub.add_parser("beads")
    sub.add_parser("memory")
    sub.add_parser("inbox")

    args = parser.parse_args()

    vault = Path(args.vault).expanduser() if getattr(args, "vault", None) else find_vault()
    if not vault:
        print("Vault not found. Use --vault to specify.", file=sys.stderr)
        sys.exit(1)

    if args.cmd == "check" or args.cmd is None:
        cmd_check(args, vault)
    elif args.cmd == "setup":
        cmd_setup(args, vault)
    elif args.cmd == "connections":
        cmd_connections(args, vault)
    elif args.cmd == "beads":
        cmd_beads(args, vault)
    elif args.cmd == "memory":
        cmd_memory(args, vault)
    elif args.cmd == "inbox":
        cmd_inbox(args, vault)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
