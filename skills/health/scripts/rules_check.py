"""
Rules check: are the instruction layers loading, within budget and consistent?

Report-only. Each check returns a list of findings; report() prints them with the
same ok/warn markers as health.py. Paths come from arguments so tests can point
every check at a temporary folder.
"""

import hashlib
import os
import re
from pathlib import Path

FILE_BUDGET = 5 * 1024          # target for user and project CLAUDE.md / AGENTS.md
ALWAYS_ON_BUDGET = 40 * 1024    # user CLAUDE.md + every rule without paths:
MEMORY_LINE_CAP = 200           # Claude Code loads the first 200 lines of MEMORY.md
MEMORY_ENTRY_CHARS = 150
SKIP_DIRS = {".git", "node_modules", ".obsidian", ".trash", "dist", "build", ".next"}

RULE_REF = re.compile(r"~/\.claude/rules/([\w.-]+\.md)")
WIKILINK = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")
SKILL_REF = re.compile(r"/braynee:([\w-]+)")
IMPORT_AGENTS = re.compile(r"^@AGENTS\.md\s*$", re.M)
ABSOLUTE_GLOB = re.compile(r"^(?:/|~|[A-Za-z]:[\\/])")


def read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def frontmatter(text: str) -> str:
    m = re.match(r"^﻿?---\r?\n(.*?)\r?\n---", text, re.S)
    return m.group(1) if m else ""


def path_globs(text: str) -> list[str]:
    """The entries of a rule's `paths:` list (block or inline form)."""
    fm = frontmatter(text)
    # [ \t]*, not \s*: \s would run across the line break into the first list item.
    m = re.search(r"^paths:[ \t]*(.*?)\r?$", fm, re.M)
    if not m:
        return []
    inline = m.group(1).strip()
    if inline.startswith("["):
        return [g.strip().strip("'\"") for g in inline.strip("[]").split(",") if g.strip()]
    if inline:
        return [inline.strip("'\"")]
    globs = []
    for line in fm[m.end():].splitlines():
        item = re.match(r"^\s*-\s*(.+)$", line)
        if not item:
            if line.strip():
                break
            continue
        globs.append(item.group(1).strip().strip("'\""))
    return globs


def is_link(p: Path) -> bool:
    if p.is_symlink():
        return True
    is_junction = getattr(p, "is_junction", None)
    return bool(is_junction and is_junction())


# ── User layer ────────────────────────────────────────────────────────────────

def check_user_layer(claude_dir: Path) -> dict:
    """Size of the user CLAUDE.md, always-on total, and absolute paths: globs."""
    out = {"claude_md_bytes": 0, "always_on_bytes": 0, "unscoped": [], "absolute_globs": []}
    cm = claude_dir / "CLAUDE.md"
    if cm.exists():
        out["claude_md_bytes"] = cm.stat().st_size
        out["always_on_bytes"] += out["claude_md_bytes"]
    rules_dir = claude_dir / "rules"
    for rule in sorted(rules_dir.glob("*.md")) if rules_dir.is_dir() else []:
        text = read(rule)
        globs = path_globs(text)
        if not globs:
            out["unscoped"].append(rule.name)
            out["always_on_bytes"] += rule.stat().st_size
        for g in globs:
            if ABSOLUTE_GLOB.match(g):
                out["absolute_globs"].append(f"{rule.name}: {g}")
    return out


# ── Dead references ───────────────────────────────────────────────────────────

def vault_names(vault: Path | None) -> set[str]:
    """Lower-cased note basenames (without .md) and attachment file names in the vault."""
    names = set()
    if not vault or not vault.is_dir():
        return names
    for root, dirs, files in os.walk(vault):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            names.add(f.lower())
            if f.endswith(".md"):
                names.add(f[:-3].lower())
    return names


def text_files(*roots: Path) -> list[Path]:
    out = []
    for root in roots:
        if root.is_file():
            out.append(root)
        elif root.is_dir():
            for p in root.rglob("*"):
                # Test files hold deliberately broken references as fixtures.
                if p.is_file() and p.suffix in (".md", ".js", ".mjs", ".cjs", ".py", ".json") \
                        and not any(part in SKIP_DIRS for part in p.parts) \
                        and not p.name.startswith("test_") and ".test." not in p.name:
                    out.append(p)
    return out


def check_dead_references(user_files: list[Path], plugin_files: list[Path], claude_dir: Path,
                          vault: Path | None, skill_names: set[str]) -> dict:
    """References to rule files, vault notes and braynee skills that do not exist.

    Wikilinks are checked only in the user's own files: braynee's shipped text
    uses example links that are not meant to resolve.
    """
    rules = {p.name for p in (claude_dir / "rules").glob("*.md")} if (claude_dir / "rules").is_dir() else set()
    notes = vault_names(vault) if vault else None
    out = {"rule_refs": [], "wikilinks": [], "skills": []}
    for files, check_links in ((user_files, True), (plugin_files, False)):
        for f in files:
            text = read(f)
            label = f.name if f.parent.name != "rules" else f"rules/{f.name}"
            for name in sorted(set(RULE_REF.findall(text))):
                if name not in rules:
                    out["rule_refs"].append(f"{label} -> ~/.claude/rules/{name}")
            for name in sorted(set(SKILL_REF.findall(text))):
                if skill_names and name not in skill_names:
                    out["skills"].append(f"{label} -> /braynee:{name}")
            if check_links and notes is not None:
                for target in sorted(set(WIKILINK.findall(text))):
                    base = target.strip().split("/")[-1].lower()
                    if base and base not in notes and base.removesuffix(".md") not in notes:
                        out["wikilinks"].append(f"{label} -> [[{target.strip()}]]")
    return out


# ── Project layer ─────────────────────────────────────────────────────────────

def find_repos(projects_dir: Path, depth: int = 2) -> list[Path]:
    """Git repos directly under projects_dir, or one folder down. Links are skipped."""
    repos = []
    if not projects_dir.is_dir():
        return repos

    def walk(d: Path, level: int):
        try:
            children = sorted(c for c in d.iterdir() if c.is_dir() and c.name not in SKIP_DIRS and not is_link(c))
        except OSError:
            return
        for c in children:
            if (c / ".git").exists():
                repos.append(c)
            elif level < depth:
                walk(c, level + 1)

    walk(projects_dir, 1)
    return repos


def check_projects(repos: list[Path]) -> dict:
    out = {"repos": len(repos), "agents_skipped": [], "identical_pair": [], "over_budget": [], "copies": []}
    by_hash: dict[str, list[str]] = {}
    for r in repos:
        cm, am = r / "CLAUDE.md", r / "AGENTS.md"
        c_text = read(cm) if cm.is_file() else None
        a_text = read(am) if am.is_file() else None
        if c_text is not None and a_text is not None:
            if c_text == a_text:
                out["identical_pair"].append(r.name)
            elif not IMPORT_AGENTS.search(c_text):
                out["agents_skipped"].append(r.name)
        for f, text in ((cm, c_text), (am, a_text)):
            if text is not None and f.stat().st_size > FILE_BUDGET:
                out["over_budget"].append(f"{r.name}/{f.name} {f.stat().st_size / 1024:.0f} KB")
        if c_text is not None and c_text.strip() and not IMPORT_AGENTS.fullmatch(c_text.strip()):
            h = hashlib.sha1(c_text.replace("\r\n", "\n").encode("utf-8")).hexdigest()
            by_hash.setdefault(h, []).append(r.name)
    out["copies"] = sorted((names for names in by_hash.values() if len(names) > 1), key=len, reverse=True)
    out["over_budget"].sort(key=lambda s: -float(s.rsplit(" ", 2)[-2]))
    return out


# ── Memory ────────────────────────────────────────────────────────────────────

def check_memory(memory_dir: Path | None, rule_names: set[str]) -> dict:
    out = {"index_lines": 0, "long_entries": [], "feedback": [], "names_rule": []}
    if not memory_dir or not memory_dir.is_dir():
        return out
    index = memory_dir / "MEMORY.md"
    if index.exists():
        lines = read(index).splitlines()
        out["index_lines"] = len(lines)
        out["long_entries"] = [l[:60] + "…" for l in lines if l.startswith("- ") and len(l) > MEMORY_ENTRY_CHARS]
    stems = {n.removesuffix(".md") for n in rule_names}
    rule_ref = re.compile(r"rules/(" + "|".join(map(re.escape, sorted(stems))) + r")\.md|`(" +
                          "|".join(map(re.escape, sorted(stems))) + r")` rule") if stems else None
    for f in sorted(memory_dir.glob("*.md")):
        if f.name in ("MEMORY.md", "ARCHIVED.md"):
            continue
        text = read(f)
        kind = re.search(r"^\s*type:\s*(\w+)\s*$", frontmatter(text), re.M)
        kind = kind.group(1) if kind else None
        if kind == "feedback":
            out["feedback"].append(f.stem)
        # A user, project or reference memory that points at a rule is a pointer, not a correction.
        elif kind is None and rule_ref and rule_ref.search(text):
            out["names_rule"].append(f.stem)
    return out


# ── Report ────────────────────────────────────────────────────────────────────

def _examples(items: list, n: int = 5) -> str:
    shown = ", ".join(items[:n])
    return shown + (f" (+{len(items) - n} more)" if len(items) > n else "")


def report(ok, warn, claude_dir: Path, vault: Path | None, projects_dir: Path,
           memory_dir: Path | None, plugin_root: Path | None, verbose: bool = False):
    n = 1000 if verbose else 5

    u = check_user_layer(claude_dir)
    kb = u["claude_md_bytes"] / 1024
    (warn if u["claude_md_bytes"] > FILE_BUDGET else ok)(f"User CLAUDE.md {kb:.1f} KB (budget 5 KB)")
    on_kb = u["always_on_bytes"] / 1024
    (warn if u["always_on_bytes"] > ALWAYS_ON_BUDGET else ok)(
        f"Always-on instructions {on_kb:.1f} KB: CLAUDE.md + {len(u['unscoped'])} rules without paths: "
        f"(budget {ALWAYS_ON_BUDGET // 1024} KB)")
    if u["absolute_globs"]:
        warn(f"{len(u['absolute_globs'])} paths: globs are absolute and never match "
             f"(globs match relative to the session's project root): {_examples(u['absolute_globs'], n)}")
    else:
        ok("paths: globs are all project-relative")

    user_files = [claude_dir / "CLAUDE.md", *sorted((claude_dir / "rules").glob("*.md")),
                  *sorted((claude_dir / "agents").glob("*.md"))]
    user_files = [f for f in user_files if f.is_file()]
    plugin_files, skills = [], set()
    if plugin_root and plugin_root.is_dir():
        plugin_files = text_files(plugin_root / "agents", plugin_root / "skills", plugin_root / "hooks",
                                  plugin_root / "scripts", plugin_root / "templates")
        # /braynee:<name> addresses skills, commands and agents alike.
        skills = {p.parent.name for p in (plugin_root / "skills").glob("*/SKILL.md")}
        skills |= {p.stem for p in (plugin_root / "commands").glob("*.md")}
        skills |= {p.stem for p in (plugin_root / "agents").glob("*.md")}
    d = check_dead_references(user_files, plugin_files, claude_dir, vault, skills)
    for key, what in (("rule_refs", "references to rule files that don't exist"),
                      ("skills", "references to braynee skills or agents that don't exist"),
                      ("wikilinks", "wikilinks in your CLAUDE.md, rules or agents with no matching note")):
        if d[key]:
            warn(f"{len(d[key])} {what}: {_examples(d[key], n)}")
        else:
            ok(f"No {what}")

    repos = find_repos(projects_dir)
    p = check_projects(repos)
    if not repos:
        ok(f"No git repos under {projects_dir} (set BRAYNEE_PROJECTS_DIR to scan elsewhere)")
    else:
        if p["agents_skipped"]:
            warn(f"{len(p['agents_skipped'])} of {p['repos']} repos have AGENTS.md that Claude Code skips "
                 f"(CLAUDE.md exists without an @AGENTS.md line): {_examples(p['agents_skipped'], n)}")
        else:
            ok(f"Every repo with both files imports AGENTS.md ({p['repos']} repos scanned)")
        if p["identical_pair"]:
            warn(f"{len(p['identical_pair'])} repos keep CLAUDE.md and AGENTS.md as identical copies "
                 f"(make CLAUDE.md `@AGENTS.md`): {_examples(p['identical_pair'], n)}")
        if p["copies"]:
            groups = ["(" + ", ".join(g[:4]) + (f" +{len(g) - 4}" if len(g) > 4 else "") + ")" for g in p["copies"]]
            warn(f"{len(p['copies'])} groups of repos share a byte-identical CLAUDE.md: {_examples(groups, n)}")
        else:
            ok("No CLAUDE.md copied between repos")
        if p["over_budget"]:
            warn(f"{len(p['over_budget'])} project instruction files over 5 KB, largest first: "
                 f"{_examples(p['over_budget'], n)}")
        else:
            ok("Project instruction files all under 5 KB")

    rule_names = {f.name for f in (claude_dir / "rules").glob("*.md")} if (claude_dir / "rules").is_dir() else set()
    m = check_memory(memory_dir, rule_names)
    if memory_dir and memory_dir.is_dir():
        (warn if m["index_lines"] >= MEMORY_LINE_CAP * 0.9 else ok)(
            f"MEMORY.md {m['index_lines']} lines (Claude Code loads the first {MEMORY_LINE_CAP})")
        if m["long_entries"]:
            warn(f"{len(m['long_entries'])} MEMORY.md entries over {MEMORY_ENTRY_CHARS} characters")
        if m["feedback"] or m["names_rule"]:
            both = sorted(set(m["feedback"]) | set(m["names_rule"]))
            warn(f"{len(both)} memories look like rule corrections (feedback type, or naming a rule file); "
                 f"move each into the rule it corrects: {_examples(both, n)}")
        else:
            ok("No memories that duplicate or correct a rule file")
