#!/usr/bin/env python3
"""
Scaffold the full vault structure from collected setup data.
Creates folders and seed notes. Never overwrites existing content.
"""

import os
import json
import argparse
import textwrap
from pathlib import Path
from datetime import date


def safe_create(path: Path, content: str = ""):
    """Create file only if it doesn't exist."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(content, encoding="utf-8")


def mkdirs(*paths: Path):
    for p in paths:
        p.mkdir(parents=True, exist_ok=True)
        placeholder = p / ".gitkeep"
        if not any(p.iterdir()):
            placeholder.touch()


def project_frontmatter(name: str, description: str, stack: list[str]) -> str:
    stack_str = ", ".join(f'"{s}"' for s in stack) if stack else ""
    return textwrap.dedent(f"""\
        ---
        type: project
        name: {name}
        description: "{description}"
        status: active
        category: product
        stack: [{stack_str}]
        date_started: {date.today()}
        ---

        # {name}

        > {description}

        ## Overview

        ## Goals

        ## Links
        - PRD: [[{name}-PRD]]

        ## Notes

    """)


def prd_frontmatter(name: str, description: str, stack: list[str]) -> str:
    stack_str = ", ".join(f'"{s}"' for s in stack) if stack else ""
    return textwrap.dedent(f"""\
        ---
        type: prd
        name: {name}
        status: draft
        stack: [{stack_str}]
        date: {date.today()}
        ---

        # {name} — PRD

        > {description}

        ## Problem

        ## Users & Use Cases

        ## Requirements

        ## Out of Scope

        ## Success Metrics

        ## Open Questions

    """)


def tech_stack_note(name: str, stack: list[str]) -> str:
    stack_list = "\n".join(f"- {s}" for s in stack) if stack else "- Unknown"
    return textwrap.dedent(f"""\
        ---
        type: decision
        project: {name}
        topic: tech-stack
        date: {date.today()}
        ---

        # {name} — Tech Stack

        ## Stack

        {stack_list}

        ## Reasoning

        ## Alternatives Considered

    """)


def strategy_note(company: str, research: dict) -> str:
    desc = research.get("description", "")
    icp = research.get("icp", "")
    industry = research.get("industry", "")
    return textwrap.dedent(f"""\
        ---
        type: strategy
        company: {company}
        date: {date.today()}
        ---

        # {company} — Strategy

        ## What We Do

        {desc}

        ## Target Customer

        {icp}

        ## Industry

        {industry}

        ## Vision

        ## Positioning

        ## Open Dilemmas

    """)


def competitor_note(company: str, competitor: dict) -> str:
    name = competitor.get("name", "Unknown")
    desc = competitor.get("description", "")
    return textwrap.dedent(f"""\
        ---
        type: competitor
        company: {company}
        competitor: {name}
        date: {date.today()}
        ---

        # {name}

        ## What They Do

        {desc}

        ## Strengths

        ## Weaknesses

        ## Differentiation from {company}

    """)


def claude_md(name: str, company: str, projects: list[dict],
              stack_summary: list[str], email: str, calendar: str,
              research: dict) -> str:
    project_lines = "\n".join(
        f"- **{p['name']}** — {p.get('description', '') or ', '.join(p.get('stack', []))}"
        for p in projects[:10]
    )
    stack_line = ", ".join(stack_summary[:10]) if stack_summary else "unknown"
    company_section = ""
    if company and company.lower() != "personal":
        desc = research.get("description", "")
        company_section = f"\n## Company\n**{company}** — {desc}\n"

    return textwrap.dedent(f"""\
        # {name}'s Second Brain
        {company_section}
        ## Who I Am

        {name}. {company if company and company.lower() != 'personal' else 'Personal vault.'}

        ## Active Projects

        {project_lines if project_lines else '(none yet)'}

        ## Tech Stack

        {stack_line}

        ## Tools

        - Email: {email}
        - Calendar: {calendar}
        - Tasks: `/tasks`
        - Search: `/query` or `qmd search "query"` (qmd is in PATH via braynee plugin)
        - Sessions: `/sessions`
        - Recall: `/recall yesterday`
        - Zettelkasten: `/zettelkasten`

        ## Vault Structure

        PARA method — Projects / Areas / Resources / Archives.
        Company knowledge: `2. Areas/Business/{company}/`
        PRDs: `2. Areas/Product Manager/PRDs/`
        Development references: `2. Areas/Development/`
        Atomic notes: `Zettelkasten/`

        ## Search (Mandatory — never use grep or find in vault)

        ```bash
        qmd search "exact terms"        # BM25 keyword search
        qmd vsearch "conceptual query"  # semantic search
        qmd query "deep research"       # CPU-intensive deep research
        obsidian search:context query="term" format=json
        ```

        Note: `qmd` command is added to PATH automatically when the braynee plugin is enabled.

        ## Writing Vault Files (Obsidian CLI — two-path rule)

        Obsidian must be running. Use the CLI for all vault file writes — never Write/Edit tools directly.

        **Path A — plain prose only** (no frontmatter, no brackets):
        ```bash
        obsidian create path="Folder/Note.md" content="# Title\\nParagraph" silent overwrite
        obsidian append path="Folder/Note.md" content="\\nMore text"
        ```

        **Path B — any note with frontmatter or structured markdown** (use by default):
        ```bash
        # Create new file
        obsidian eval code="(async () => {{ await app.vault.create('Folder/Note.md', 'content\\n'); }})()"

        # Overwrite existing file
        obsidian eval code="(async () => {{ const f = app.vault.getFileByPath('Folder/Note.md'); await app.vault.modify(f, 'new content\\n'); }})()"

        # Append to existing file
        obsidian eval code="(async () => {{ const f = app.vault.getFileByPath('Folder/Note.md'); const cur = await app.vault.read(f); await app.vault.modify(f, cur + '\\nappended\\n'); }})()"
        ```

        Escaping inside eval code="..." (bash double-quoted string wrapping JS):
        - Single quote ' → \\'
        - Double quote " → \\"
        - Newline → \\n
        - Backslash \\ → \\\\\\\\

        ## Rules

        - Tasks: always use `/tasks` — never create task files manually
        - Captures: new ideas go to `Inbox/` first
        - Sessions: logged automatically in `2. Areas/Sessions/`
        - Decisions: append to decisions log, never delete history
    """)


def audit_vault(vault: Path, company: str = "personal") -> dict:
    """
    Check what's present vs. missing in an existing vault.
    Returns JSON-serializable dict — no files are created.
    """
    is_personal = company.lower() == "personal"

    CORE_DIRS = [
        vault / "Inbox",
        vault / "1. Projects",
        vault / "2. Areas" / "context",
        vault / "2. Areas" / "Sessions",
        vault / "2. Areas" / "Claude Memory",
        vault / "2. Areas" / "Product Manager" / "PRDs",
        vault / "3. Resources" / "Templates",
        vault / "4. Archives" / "Projects",
        vault / "Zettelkasten",
    ]
    CORE_FILES = [
        vault / "CLAUDE.md",
        vault / "2. Areas" / "connections.md",
        vault / "2. Areas" / "context" / "about-me.md",
        vault / "2. Areas" / "context" / "about-business.md",
        vault / "2. Areas" / "context" / "priorities.md",
        vault / "2. Areas" / "context" / "voice.md",
    ]
    if not is_personal:
        biz = vault / "2. Areas" / "Business" / company
        CORE_DIRS += [
            biz / "Org" / "Decisions",
            biz / "Org" / "Strategy",
            biz / "Teams" / "Engineering",
            biz / "Clients",
        ]
        CORE_FILES += [
            biz / "Org" / "Decisions" / "log.md",
            biz / "Org" / "Strategy" / "strategy.md",
        ]

    missing_dirs  = [str(d.relative_to(vault)) for d in CORE_DIRS  if not d.exists()]
    missing_files = [str(f.relative_to(vault)) for f in CORE_FILES if not f.exists()]

    return {
        "vault": str(vault),
        "vault_exists": vault.exists(),
        "missing_dirs":  missing_dirs,
        "missing_files": missing_files,
        "has_claude_md":   (vault / "CLAUDE.md").exists(),
        "has_context":     (vault / "2. Areas" / "context").is_dir(),
        "has_connections": (vault / "2. Areas" / "connections.md").exists(),
        "total_missing":   len(missing_dirs) + len(missing_files),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault",    required=True)
    parser.add_argument("--name",     default="")
    parser.add_argument("--company",  default="personal")
    parser.add_argument("--projects", default="[]")
    parser.add_argument("--stack",    default="{}")
    parser.add_argument("--email",    default="unknown")
    parser.add_argument("--calendar", default="unknown")
    parser.add_argument("--research", default="{}")
    parser.add_argument("--check",    action="store_true",
                        help="Audit vault without creating anything — outputs JSON")
    args = parser.parse_args()

    if args.check:
        print(json.dumps(audit_vault(Path(args.vault), args.company), indent=2))
        return

    if not args.name:
        print("error: --name is required when scaffolding", file=__import__("sys").stderr)
        raise SystemExit(1)

    vault = Path(args.vault)
    company = args.company
    projects: list[dict] = json.loads(args.projects)
    stack_map: dict = json.loads(args.stack)    # {repo_name: [frameworks]}
    research: dict = json.loads(args.research)
    is_personal = company.lower() == "personal"

    # ── PARA Core ──────────────────────────────────────────────────────────

    mkdirs(
        vault / "Inbox",
        vault / "1. Projects",
        vault / "2. Areas" / "TaskNotes",
        vault / "2. Areas" / "Sessions",
        vault / "2. Areas" / "Claude Memory",
        vault / "2. Areas" / "context",
        vault / "2. Areas" / "Product Manager" / "PRDs",
        vault / "2. Areas" / "Product Manager" / "Roadmaps",
        vault / "2. Areas" / "Product Manager" / "Research",
        vault / "2. Areas" / "Product Manager" / "Launches",
        vault / "2. Areas" / "Product Manager" / "Metrics",
        vault / "3. Resources" / "Templates",
        vault / "4. Archives" / "Projects",
        vault / "4. Archives" / "Tasks",
        vault / "Zettelkasten",
    )

    # ── Context files (Claude-readable self-description) ───────────────────────
    ctx = vault / "2. Areas" / "context"
    safe_create(ctx / "about-me.md",
        f"---\ntype: context\ntopic: about-me\n---\n\n# About Me\n\n**Name:** {args.name}\n\n**Role:**\n\n**Background:**\n\n**Working style:**\n")
    safe_create(ctx / "about-business.md",
        f"---\ntype: context\ntopic: about-business\n---\n\n# About the Business\n\n**Company:** {company if not is_personal else 'Personal'}\n\n**What we do:**\n\n**ICP:**\n\n**Revenue model:**\n")
    safe_create(ctx / "priorities.md",
        f"---\ntype: context\ntopic: priorities\n---\n\n# Current Priorities\n\n## This Month\n\n## This Quarter\n\n## Blockers\n")
    safe_create(ctx / "voice.md",
        f"---\ntype: context\ntopic: voice\n---\n\n# My Voice & Communication Style\n\n## Writing tone\n\n## Things I say\n\n## Things I don't say\n")

    # ── Connections registry (7 Tier-1 domains) ────────────────────────────────
    safe_create(vault / "2. Areas" / "connections.md",
        f"---\ntype: connections\n---\n\n# Connections — Tier-1 Domains\n\n"
        f"The 7 systems that must stay live for the second brain to function.\n\n"
        f"| Domain | Tool | Status | Notes |\n|---|---|---|---|\n"
        f"| Revenue | TaskNotes API (http://127.0.0.1:8090) | | |\n"
        f"| Customer | 2. Areas/Business/Clients/ | | |\n"
        f"| Comms | obsidian CLI | | |\n"
        f"| Tasks | Beads (bd) | | |\n"
        f"| Knowledge | QMD search index | | |\n"
    )

    # ── Development section (only detected frameworks) ─────────────────────

    all_stack = []
    for stack_list in stack_map.values():
        all_stack.extend(stack_list)
    unique_stack = list(dict.fromkeys(all_stack))

    for framework in unique_stack:
        fw_path = vault / "2. Areas" / "Development" / framework
        safe_create(
            fw_path / f"{framework}.md",
            f"---\ntype: reference\nframework: {framework}\n---\n\n# {framework}\n\n## Key Docs\n\n## Patterns\n\n## Notes\n"
        )

    # ── Projects ───────────────────────────────────────────────────────────

    for project in projects:
        pname = project["name"]
        pdesc = project.get("description", "")
        pstack = stack_map.get(pname, project.get("stack", []))

        # 1. Projects/ stub
        safe_create(
            vault / "1. Projects" / f"{pname}.md",
            project_frontmatter(pname, pdesc, pstack)
        )

        # PRD
        safe_create(
            vault / "2. Areas" / "Product Manager" / "PRDs" / f"{pname}-PRD.md",
            prd_frontmatter(pname, pdesc, pstack)
        )

        # Company project folder
        if not is_personal:
            proj_dir = vault / "2. Areas" / "Business" / company / "Projects" / pname
            mkdirs(proj_dir / "Features", proj_dir / "Decisions")
            safe_create(
                proj_dir / "PRD" / "overview.md",
                f"---\ntype: prd-ref\nproject: {pname}\n---\n\n# {pname} — PRD\n\nSee [[{pname}-PRD]]\n"
            )
            if pstack:
                safe_create(
                    proj_dir / "Decisions" / "tech-stack.md",
                    tech_stack_note(pname, pstack)
                )

    # ── Company Section ────────────────────────────────────────────────────

    if not is_personal:
        biz = vault / "2. Areas" / "Business" / company

        mkdirs(
            biz / "Org" / "Decisions",
            biz / "Org" / "Strategy",
            biz / "Org" / "Competitors",
            biz / "Org" / "Pipeline",
            biz / "Org" / "Risks",
            biz / "Teams" / "Engineering",
            biz / "Teams" / "Marketing",
            biz / "Teams" / "Sales",
            biz / "Clients",
            biz / "Research",
            biz / "Transcripts",
            biz / "Archive",
        )

        # Append-only decisions log
        safe_create(
            biz / "Org" / "Decisions" / "log.md",
            f"---\ntype: decisions-log\ncompany: {company}\n---\n\n# Decisions Log\n\n"
            f"Append-only. Never delete entries. Format: `[YYYY-MM-DD] Decision — Reason`\n\n"
            f"---\n\n[{date.today()}] Initialized vault via second-brain setup wizard.\n"
        )

        # Strategy note (seeded from web research)
        safe_create(
            biz / "Org" / "Strategy" / "strategy.md",
            strategy_note(company, research)
        )

        # Competitor notes
        for competitor in research.get("competitors", []):
            cname = competitor.get("name", "unknown").replace("/", "-")
            safe_create(
                biz / "Org" / "Competitors" / f"{cname}.md",
                competitor_note(company, competitor)
            )

        # Industry research note
        industry_content = research.get("industry_overview", "")
        safe_create(
            biz / "Research" / "industry-overview.md",
            f"---\ntype: research\ntopic: industry\ncompany: {company}\ndate: {date.today()}\n---\n\n# Industry Overview\n\n{industry_content}\n"
        )

    # ── Claude Memory ──────────────────────────────────────────────────────
    # Seed the MEMORY.md index that Claude's auto-memory system maintains.
    # Individual memory files are created by Claude as it learns about the user.

    safe_create(
        vault / "2. Areas" / "Claude Memory" / "MEMORY.md",
        f"""# Claude Memory Index

## User
*(Claude will add entries here as it learns about you)*

## Feedback
*(Guidance Claude has received about how to work with you)*

## Projects
*(Key decisions and context for active projects)*

## References
*(Pointers to external systems and resources)*
"""
    )

    # ── CLAUDE.md ──────────────────────────────────────────────────────────

    safe_create(
        vault / "CLAUDE.md",
        claude_md(args.name, company, projects, unique_stack,
                  args.email, args.calendar, research)
    )

    print(json.dumps({
        "status": "ok",
        "vault": str(vault),
        "projects_scaffolded": len(projects),
        "frameworks_detected": len(unique_stack),
        "company": company if not is_personal else None,
    }))


if __name__ == "__main__":
    main()
