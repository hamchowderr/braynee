---
name: insightful
description: "Generate a comprehensive insights report from ALL Claude Code conversations across ALL projects. Covers every session ever, not just recent ones. Use when the user wants a complete overview of their entire Claude Code usage history. Unlike the built-in /insights which only analyzes recent sessions, Insightful merges 5 data sources (history.jsonl, stats-cache, facets, session indexes, and full .jsonl transcripts) to produce a rich HTML report covering your complete history — every project, every session, all time."
---

# Insightful — Complete Claude Code Usage Report

Generate a comprehensive HTML insights report covering every Claude Code conversation across all projects. This skill produces a report matching the depth and quality of the built-in `/insights` command — with the same structured analysis stages — but covering ALL sessions ever, not just recent ones.

## How Insightful differs from `/insights`

| | Built-in `/insights` | Insightful |
|:--|:-----|:-----|
| **Scope** | Recent sessions only | Every session ever recorded |
| **Data sources** | stats-cache + recent facets | 5 sources: history.jsonl, stats-cache, facets, session indexes, .jsonl transcripts |
| **Git commits** | Not tracked | Detected from Bash tool calls in .jsonl files |
| **Hours spent** | Not tracked | Calculated from session timestamps |
| **Multi-clauding** | Not analyzed | Detects concurrent session overlaps |
| **Notable sessions** | Not included | Top 5 most intense sessions highlighted |
| **Evolution** | Not tracked | Month-over-month usage trends |
| **Pre-tracking data** | Invisible | Recovers sessions from before stats-cache existed |
| **Output** | In-terminal summary | Interactive HTML report with charts, copy buttons, collapsible sections |

## Step 0: Backfill Facets (first-time setup)

Facets are qualitative per-session analysis files (goal, outcome, satisfaction, friction, helpfulness). Claude Code generates them automatically going forward, but older sessions may not have them — which means gaps in satisfaction and friction analysis.

Run the collect script first to check coverage:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/insightful/collect-insights.js"
```

If it prints a `⚠️ FACET COVERAGE LOW` warning, backfill your historical sessions before generating the report. Start with a small chunk to see costs first:

```bash
# Dry run — shows what would be processed, no API calls
node "${CLAUDE_PLUGIN_ROOT}/skills/insightful/backfill-facets.mjs" --dry-run

# Run first 50 sessions (~$0.20 at Haiku pricing)
node "${CLAUDE_PLUGIN_ROOT}/skills/insightful/backfill-facets.mjs" --chunk=50

# Run all remaining once you've verified quality
node "${CLAUDE_PLUGIN_ROOT}/skills/insightful/backfill-facets.mjs" --chunk=500
```

Cost: ~$0.004 per session using `claude-haiku-4-5-20251001`. A full backfill of 400 sessions costs roughly $1.50.
Re-run `collect-insights.js` after backfilling to confirm coverage improved.

## Step 1: Collect Data

Run the pre-aggregation script to scan all session data:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/insightful/collect-insights.js"
```

This merges 5 data sources (history.jsonl, stats-cache.json, facets, sessions-index.json, .jsonl transcripts) and writes a comprehensive JSON summary to `~/.claude/usage-data/insightful-data.json`.

Output includes: sessions, projects, git commits, hours spent, tool usage, model usage, facets, and message accounting.

## Step 2: Analyze Data with Parallel Agents (Structured Stages)

The JSON output is typically 500KB–1MB — too large for a single context window. **You MUST use parallel agents to analyze the data deeply.** The agents must return structured analysis matching these exact stages (the same ones the built-in `/insights` uses internally).

Launch these 2 agents concurrently:

### Agent 1: Narrative & Projects Agent
Use a `general-purpose` Task agent with this prompt:

> Read `~/.claude/usage-data/insightful-data.json`. Analyze the data and return a structured report with these EXACT sections. Be specific — reference actual project names, session counts, tool names, dates, and first_prompts from the data:
>
> **1. project_areas** — For each of the top 20 projects (by session count), provide: name, session_count, date_range (first–last session), and a detailed 3-4 sentence description referencing SPECIFIC things the user did (based on first_prompts, facet summaries, tools used). Group remaining small projects into a summary.
>
> **2. interaction_style** — Analyze how the user interacts with Claude Code: their iteration style (do they give detailed specs upfront or iterate?), interruption patterns (do they let Claude finish or redirect mid-task?), feedback style (how they express satisfaction/frustration), preferred workflow (agents, single-shot, planning mode?). Write 2 specific paragraphs with examples.
>
> **3. what_works** — Identify 3-4 impressive things the user accomplished. Each needs a title and a 2-3 sentence description referencing specific projects, sessions, and outcomes. These should be genuinely impressive achievements.
>
> **4. at_a_glance** — Write 4 short paragraphs: (a) What's working well — specific tools, patterns, projects succeeding, (b) What's hindering — specific friction points from facets and session data, (c) Quick wins to try — actionable 1-sentence suggestions, (d) Ambitious workflows to explore — forward-looking ideas based on what the user already does well.
>
> **5. fun_ending** — Find one genuinely funny, surprising, or memorable moment from the sessions. Write a punchy headline (under 10 words) and a 2-sentence detail. Look at first_prompts, session patterns, marathon sessions, or unusual projects.
>
> Return all 5 sections clearly labeled.

### Agent 2: Metrics & Suggestions Agent
Use a `general-purpose` Task agent with this prompt:

> Read `~/.claude/usage-data/insightful-data.json`. Analyze the data and return a structured report with these EXACT sections. Be specific — use actual numbers, project names, dates, and tool names from the data:
>
> **1. friction_analysis** — Identify the top 3-5 friction categories from the facets data (all_facets array). For each: category name, occurrence count, a description of the pattern, AND 1-2 specific examples quoting actual session data. If no facets exist, analyze session patterns for likely friction points.
>
> **2. personalization_plan** — Four sub-sections. Everything must be derived from the user's ACTUAL data — friction counts, session types, tool usage patterns, facets. No generic tips.
>   - **hooks**: 3-5 hooks to add to `settings.json`. For each: a title, the exact JSON block (hook event + shell command, ready to paste), and a "why" citing the specific pattern in their data that justifies it. Available hook events: `UserPromptSubmit` (fires when user submits a prompt — good for injecting context or reminders), `PostToolUse` (fires after any tool runs — good for auto-running tests after Edit, logging, etc.), `Stop` (fires when Claude finishes responding — good for mandatory git checks, reminders), `PreToolUse` (fires before a tool runs — good for safety gates). Example: if they have many sessions with missing-commit friction → `Stop` hook running `git status`. If they have context-loss friction → `UserPromptSubmit` hook echoing a project summary. Base every hook on evidence from their data.
>   - **claude_md_instructions**: 5-7 instructions for CLAUDE.md, each traceable to a real pattern or friction in their data. Each needs: the exact instruction text (imperative voice, copy-pasteable as a bullet or rule), whether it's global or project-specific, and a one-line "Evidence:" note citing the data. Must be specific to this user — not reminders every developer needs.
>   - **skills_to_build**: 3 custom Claude Code skills the user should build, based on tasks repeated across multiple sessions. Each needs: skill name, 2-sentence description of what it does, which specific sessions/projects show the repeating pattern, and a starter prompt they can paste to begin building it.
>   - **settings_to_configure**: 3-4 `settings.json` changes (tools to pre-allow in permissions, env vars to set, or other settings). Each needs: the exact JSON and a one-sentence justification from their tool usage or friction data.
>
> **3. on_the_horizon** — 3 forward-looking automation opportunities based on what the user already does. Each needs: title, description of the opportunity, and a specific copyable prompt to get started. Think about what they could automate next given their existing tools and projects.
>
> **4. multi_clauding** — Analyze session overlap: find sessions that overlap in time (compare first_timestamp to last_timestamp across sessions). Count: total overlap events, max concurrent sessions, peak date, and list the top 5 cross-project pairs that run simultaneously most often. If the data shows no overlaps, say so.
>
> **5. notable_sessions** — Find the 5 most interesting/intense sessions. For each: project, date, prompt count, tool count, duration, and a 1-2 sentence description of what happened.
>
> **6. evolution** — How has usage changed over time? Monthly trends in sessions/messages, model adoption changes, shifts in project focus, and any key inflection points. Include specific numbers.
>
> Return all 6 sections clearly labeled.

## Step 3: Read Summary Stats Directly

While agents process, extract the top-level stats:

```bash
node -e "const d=require(process.env.USERPROFILE+'/.claude/usage-data/insightful-data.json'); console.log(JSON.stringify({sessions:d.total_sessions_found, stats_sessions:d.total_sessions_from_stats, stats_messages:d.total_messages_from_stats, projects:d.total_projects, git_commits:d.total_git_commits, hours:d.total_hours, facets:d.sessions_with_facets, accounting:d.message_accounting, sources:d.data_sources, facets_summary:d.facets_summary, tools:d.global_tool_totals}, null, 2));"
```

Also extract: `stats_cache.modelUsage`, `stats_cache.hourCounts`, `stats_cache.dailyActivity`, `all_facets` friction details.

## Step 4: Launch Report Writer Agent

Once agents 1 & 2 return AND you have the summary stats from Step 3, launch a 3rd `general-purpose` Task agent to assemble and write the HTML report. This offloads report generation to a fresh context, keeping the main session lightweight and avoiding context bloat from the large HTML.

Pass these to the agent's prompt:
- The COMPLETE output from Agent 1 (all 5 sections)
- The COMPLETE output from Agent 2 (all 6 sections)
- The summary stats JSON from Step 3
- Model usage, hour counts, and daily activity data extracted in Step 3

The agent's prompt must instruct it to:
1. Read `${CLAUDE_PLUGIN_ROOT}/skills/insightful/SKILL.md` for the full CSS spec, JavaScript code, and all 25 section requirements
2. Read `~/.claude/usage-data/insightful-data.json` for chart data (facets_summary, project details, tool totals, etc.)
3. Generate the complete HTML following every section, style, and interactivity requirement
4. Write the file to `~/.claude/usage-data/insightful-report.html`

The report should load per-project session lists dynamically from `insightful-data.json` via JavaScript `fetch()` to keep the HTML file manageable.

### Quality Bar — Match the Built-in `/insights`

The built-in `/insights` skill runs these structured analysis stages: `project_areas`, `interaction_style`, `what_works`, `friction_analysis`, `suggestions`, `on_the_horizon`, `at_a_glance`, `fun_ending`. Our report must include ALL of them, plus the extras we add (multi-clauding, notable sessions, evolution, git commits, hours).

This means:
- **Multi-paragraph narrative sections** analyzing the user's working style with specific examples
- **"Impressive Things You Did"** section with 3-4 detailed big wins (green cards)
- **Hooks to Add** — 3-5 hooks with exact JSON the user can paste into settings.json, each justified by their actual data
- **CLAUDE.md Instructions** with checkboxes and a "Copy All Checked" button — each instruction with exact text and evidence from their data
- **Skills to Build** — repeating tasks that should be custom skills, with starter prompts
- **Settings to Configure** — specific settings.json changes with justification
- **"On the Horizon"** — forward-looking automation opportunities with copyable prompts
- **Interaction Style** — dedicated section analyzing how the user works with Claude Code
- **Detailed friction analysis** with specific examples from facets, not just counts
- **Rich project descriptions** that reference what the user actually did, not generic summaries
- **Multi-clauding detection** stats if concurrent sessions were found
- **Notable sessions** — the 5 most intense/interesting sessions
- **Evolution over time** — how usage changed month-to-month
- **Git commits and hours** in the stats row
- **Fun Ending** — a memorable moment from the sessions
- **Data transparency** — clearly explain what data is tracked vs estimated vs unrecoverable

### Message Accounting

The `message_accounting` field in the JSON provides honest numbers:
- `tracked_messages`: Real message count from stats-cache (only covers the tracked period)
- `tracked_period_start`: When stats tracking began
- `pre_tracking_sessions`: Sessions before stats tracking existed
- `pre_tracking_prompts`: User prompts from those sessions (assistant messages are unrecoverable)
- `total_user_prompts`: All prompts across all sources

**Always be transparent**: Show tracked messages for the tracked period, total prompts for all sessions, and clearly explain the gap for pre-tracking sessions.

### CSS and Visual Style

Use this exact CSS (matching the existing report style):

```css
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: #f8fafc; color: #334155; line-height: 1.65; padding: 48px 24px; }
.container { max-width: 800px; margin: 0 auto; }
h1 { font-size: 32px; font-weight: 700; color: #0f172a; margin-bottom: 8px; }
h2 { font-size: 20px; font-weight: 600; color: #0f172a; margin-top: 48px; margin-bottom: 16px; }
.subtitle { color: #64748b; font-size: 15px; margin-bottom: 32px; }
.nav-toc { display: flex; flex-wrap: wrap; gap: 8px; margin: 24px 0 32px 0; padding: 16px; background: white; border-radius: 8px; border: 1px solid #e2e8f0; }
.nav-toc a { font-size: 12px; color: #64748b; text-decoration: none; padding: 6px 12px; border-radius: 6px; background: #f1f5f9; transition: all 0.15s; }
.nav-toc a:hover { background: #e2e8f0; color: #334155; }
.stats-row { display: flex; gap: 24px; margin-bottom: 40px; padding: 20px 0; border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; flex-wrap: wrap; }
.stat { text-align: center; }
.stat-value { font-size: 24px; font-weight: 700; color: #0f172a; }
.stat-label { font-size: 11px; color: #64748b; text-transform: uppercase; }
.at-a-glance { background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border: 1px solid #f59e0b; border-radius: 12px; padding: 20px 24px; margin-bottom: 32px; }
.glance-title { font-size: 16px; font-weight: 700; color: #92400e; margin-bottom: 16px; }
.glance-sections { display: flex; flex-direction: column; gap: 12px; }
.glance-section { font-size: 14px; color: #78350f; line-height: 1.6; }
.glance-section strong { color: #92400e; }
.project-areas { display: flex; flex-direction: column; gap: 12px; margin-bottom: 32px; }
.project-area { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
.area-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.area-name { font-weight: 600; font-size: 15px; color: #0f172a; }
.area-count { font-size: 12px; color: #64748b; background: #f1f5f9; padding: 2px 8px; border-radius: 4px; }
.area-desc { font-size: 14px; color: #475569; line-height: 1.5; }
.area-meta { font-size: 12px; color: #94a3b8; margin-top: 6px; }
.narrative { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin-bottom: 24px; }
.narrative p { margin-bottom: 12px; font-size: 14px; color: #475569; line-height: 1.7; }
.key-insight { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 12px 16px; margin-top: 12px; font-size: 14px; color: #166534; }
.charts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 24px 0; }
.chart-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
.chart-card.full-width { grid-column: 1 / -1; }
.chart-title { font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase; margin-bottom: 12px; }
.bar-row { display: flex; align-items: center; margin-bottom: 6px; }
.bar-label { width: 100px; font-size: 11px; color: #475569; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { flex: 1; height: 6px; background: #f1f5f9; border-radius: 3px; margin: 0 8px; }
.bar-fill { height: 100%; border-radius: 3px; }
.bar-value { width: 48px; font-size: 11px; font-weight: 500; color: #64748b; text-align: right; }
.friction-categories { display: flex; flex-direction: column; gap: 16px; margin-bottom: 24px; }
.friction-category { background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; padding: 16px; }
.friction-title { font-weight: 600; font-size: 15px; color: #991b1b; margin-bottom: 6px; }
.friction-desc { font-size: 13px; color: #7f1d1d; margin-bottom: 10px; }
.friction-example { font-size: 12px; color: #991b1b; background: rgba(255,255,255,0.5); padding: 8px 12px; border-radius: 6px; margin-top: 6px; line-height: 1.5; }
.big-wins { display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; }
.big-win { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; }
.big-win-title { font-weight: 600; font-size: 15px; color: #166534; margin-bottom: 8px; }
.big-win-desc { font-size: 14px; color: #15803d; line-height: 1.5; }
.collapsible-section { margin-top: 16px; }
.collapsible-header { display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 12px 0; border-bottom: 1px solid #e2e8f0; }
.collapsible-header h3 { margin: 0; font-size: 14px; font-weight: 600; color: #475569; }
.collapsible-arrow { font-size: 12px; color: #94a3b8; transition: transform 0.2s; }
.collapsible-content { display: none; padding-top: 16px; }
.collapsible-content.open { display: block; }
.collapsible-header.open .collapsible-arrow { transform: rotate(90deg); }
.session-list { font-size: 13px; color: #475569; }
.session-item { padding: 8px 0; border-bottom: 1px solid #f1f5f9; }
.session-date { font-size: 11px; color: #94a3b8; }
.session-prompt { color: #334155; }
.source-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; margin-left: 6px; }
.source-badge.history { background: #dbeafe; color: #1e40af; }
.source-badge.jsonl { background: #d1fae5; color: #065f46; }
.source-badge.index { background: #fef3c7; color: #92400e; }
.timeline-chart { width: 100%; }
.timeline-bar { display: inline-block; vertical-align: bottom; margin-right: 1px; background: #3b82f6; border-radius: 2px 2px 0 0; min-width: 4px; }
.timeline-labels { display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; margin-top: 4px; }
/* CLAUDE.md suggestions with checkboxes */
.claude-md-section { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin-bottom: 24px; }
.claude-md-item { display: flex; align-items: flex-start; gap: 12px; padding: 12px 0; border-bottom: 1px solid #f1f5f9; }
.claude-md-item:last-child { border-bottom: none; }
.cmd-checkbox { margin-top: 3px; width: 16px; height: 16px; accent-color: #3b82f6; cursor: pointer; }
.cmd-code { font-family: 'SF Mono', Menlo, monospace; font-size: 13px; color: #1e293b; background: #f8fafc; padding: 6px 10px; border-radius: 4px; border: 1px solid #e2e8f0; flex: 1; }
.cmd-why { font-size: 12px; color: #64748b; margin-top: 4px; }
.copy-btn { font-size: 11px; padding: 4px 8px; border: 1px solid #e2e8f0; border-radius: 4px; background: white; cursor: pointer; color: #64748b; white-space: nowrap; }
.copy-btn:hover { background: #f1f5f9; }
.copy-all-btn { font-size: 12px; padding: 6px 14px; border: 1px solid #3b82f6; border-radius: 6px; background: #3b82f6; color: white; cursor: pointer; margin-bottom: 16px; }
.copy-all-btn:hover { background: #2563eb; }
/* Feature cards */
.feature-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
.feature-card { background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 8px; padding: 14px; }
.feature-name { font-weight: 600; font-size: 14px; color: #6b21a8; margin-bottom: 4px; }
.feature-desc { font-size: 13px; color: #7e22ce; line-height: 1.4; }
/* Workflow tips */
.tip-grid { display: grid; grid-template-columns: 1fr; gap: 10px; margin-bottom: 24px; }
.tip-card { background: #f0fdfa; border: 1px solid #99f6e4; border-radius: 8px; padding: 12px 16px; }
.tip-title { font-weight: 600; font-size: 13px; color: #0f766e; margin-bottom: 2px; }
.tip-desc { font-size: 13px; color: #115e59; }
/* Copyable prompts */
.pattern-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
.pattern-name { font-weight: 600; font-size: 15px; color: #0f172a; margin-bottom: 6px; }
.pattern-desc { font-size: 14px; color: #475569; line-height: 1.5; margin-bottom: 10px; }
.copyable-prompt-row { display: flex; align-items: center; gap: 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 12px; }
.copyable-prompt { font-family: 'SF Mono', Menlo, monospace; font-size: 12px; color: #334155; flex: 1; white-space: pre-wrap; }
/* Horizon cards */
.horizon-card { background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%); border: 1px solid #93c5fd; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
.horizon-title { font-weight: 600; font-size: 15px; color: #1e40af; margin-bottom: 6px; }
.horizon-desc { font-size: 14px; color: #1e3a5f; line-height: 1.5; margin-bottom: 10px; }
.horizon-tip { font-size: 12px; color: #3b82f6; margin-bottom: 8px; }
.pattern-prompt { display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.7); border: 1px solid #bfdbfe; border-radius: 6px; padding: 8px 12px; }
/* Fun ending */
.fun-ending { background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border: 1px solid #fbbf24; border-radius: 12px; padding: 24px; margin-top: 40px; text-align: center; }
.fun-headline { font-size: 18px; font-weight: 700; color: #92400e; margin-bottom: 8px; }
.fun-detail { font-size: 14px; color: #78350f; line-height: 1.6; }
/* Notable sessions */
.notable-grid { display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; }
.notable-card { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px; }
.notable-title { font-weight: 600; font-size: 14px; color: #92400e; margin-bottom: 4px; }
.notable-meta { font-size: 12px; color: #b45309; margin-bottom: 6px; }
.notable-desc { font-size: 13px; color: #78350f; line-height: 1.5; }
/* Evolution cards */
.evolution-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
.evolution-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; }
.evolution-label { font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase; margin-bottom: 6px; }
.evolution-value { font-size: 13px; color: #334155; line-height: 1.5; }
/* Hook cards */
.hook-section { display: flex; flex-direction: column; gap: 16px; margin-bottom: 24px; }
.hook-card { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; }
.hook-title { font-weight: 600; font-size: 15px; color: #166534; margin-bottom: 4px; }
.hook-why { font-size: 13px; color: #15803d; margin-bottom: 10px; line-height: 1.5; }
.hook-json { background: #1e293b; color: #e2e8f0; font-family: 'SF Mono', Menlo, monospace; font-size: 12px; border-radius: 6px; padding: 12px 14px; white-space: pre; overflow-x: auto; }
.hook-copy-row { display: flex; justify-content: flex-end; margin-top: 8px; }
/* Multi-claude stats */
.multi-claude-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }
.multi-claude-stat { background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 12px; text-align: center; }
.multi-claude-value { font-size: 20px; font-weight: 700; color: #0369a1; }
.multi-claude-label { font-size: 11px; color: #0c4a6e; text-transform: uppercase; }
@media (max-width: 640px) { .charts-row { grid-template-columns: 1fr; } .stats-row { justify-content: center; } .feature-grid { grid-template-columns: 1fr; } .evolution-grid { grid-template-columns: 1fr; } }
```

Also include the Google Fonts link for Inter:
```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
```

### Required Sections (in order)

These map directly to the built-in `/insights` analysis stages plus our enhancements:

1. **Title**: "Claude Code: Complete Usage Insights"
2. **Subtitle**: Show total sessions found, total user prompts, tracked messages with period, number of projects, hours spent, git commits, and full date range
3. **At a Glance** (gold `.at-a-glance` box): 4 paragraphs from Agent 1's `at_a_glance` — what's working, what's hindering, quick wins, ambitious workflows. Must reference specific projects, tools, and patterns.
4. **Navigation TOC** (`.nav-toc`): Links to each section below
5. **Stats Row**: Sessions | Prompts | Projects | Hours | Git Commits | Tracked Messages (period) | Models
6. **Data transparency note**: Yellow box explaining message accounting — tracked vs unrecoverable. Also note that git commits are only detectable from .jsonl files (not history-only sessions).
7. **How You Use Claude Code** (`.narrative`): From Agent 1's `interaction_style` — multi-paragraph personality/workflow analysis with key-insight box
8. **Project Breakdown** (`.project-areas`): Rich cards from Agent 1's `project_areas`. Include session count, date range, hours, git commits per project.
9. **Impressive Things You Did** (`.big-wins`): 3-4 green cards from Agent 1's `what_works`
10. **Notable Sessions** (`.notable-grid`): 5 cards from Agent 2's `notable_sessions`
11. **Multi-Clauding Stats** (if detected): From Agent 2's `multi_clauding` — stats grid + top pairs
12. **Evolution Over Time**: From Agent 2's `evolution` — cards showing month-to-month changes
13. **Usage Timeline**: Bar chart from `stats_cache.dailyActivity` with hover tooltips
14. **Tool Usage** (`.charts-row`): Bar chart of top 15 tools
15. **Model Usage** (`.chart-card`): Bar chart of output tokens by model, plus cache stats
16. **Working Hours** (`.chart-card`): Bar chart of `stats_cache.hourCounts`
17. **Session Outcomes** (if facets exist): Goal achievement + satisfaction charts
18. **Friction Analysis** (`.friction-categories`): From Agent 2's `friction_analysis` — detailed cards with counts, descriptions, AND specific examples
19. **Hooks to Add** (`.hook-section`): From Agent 2's `personalization_plan.hooks` — each hook as a `.hook-card` showing title, why, and the exact JSON in a `<pre>` block with a Copy button. Ordered by impact (most impactful first).
20. **CLAUDE.md Instructions** (`.claude-md-section`): From Agent 2's `personalization_plan.claude_md_instructions` — checkbox format with individual "Copy" buttons and "Copy All Checked" button. Include the Evidence line in smaller text under each item.
21. **Skills to Build** (`.pattern-card`s): From Agent 2's `personalization_plan.skills_to_build` — cards with skill name, description, the sessions/projects that evidence the pattern, and a copyable starter prompt.
22. **Settings to Configure** (`.feature-grid`): From Agent 2's `personalization_plan.settings_to_configure` — purple cards with exact JSON snippet and justification.
23. **On the Horizon** (`.horizon-card`s): From Agent 2's `on_the_horizon` — blue gradient cards with copyable prompts
24. **Fun Ending** (`.fun-ending`): From Agent 1's `fun_ending` — gold card with headline and detail
25. **Per-Project Sessions**: Load dynamically from JSON via `fetch('insightful-data.json')` — collapsible sections with session lists showing date, source badge, first prompt, message count, tool count, and facet summary
26. **Data Coverage Note**: Full breakdown of all 5 data sources, message accounting, git commit detection limitations, and what's recoverable vs not

### JavaScript

Include these functions at the bottom of the HTML:

```javascript
// Copy text from a sibling .copyable-prompt element
function copyText(btn) {
  const container = btn.closest('.copyable-prompt-row') || btn.closest('.pattern-prompt') || btn.parentElement;
  const code = container.querySelector('.copyable-prompt') || container.querySelector('code');
  if (!code) return;
  navigator.clipboard.writeText(code.textContent.trim()).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.style.background = '#d1fae5';
    btn.style.color = '#065f46';
    setTimeout(() => { btn.textContent = orig; btn.style.background = ''; btn.style.color = ''; }, 1500);
  });
}

// Copy a single CLAUDE.md suggestion by index
function copyCmdItem(idx) {
  const items = document.querySelectorAll('.claude-md-item');
  if (idx >= items.length) return;
  const code = items[idx].querySelector('.cmd-code');
  if (!code) return;
  navigator.clipboard.writeText(code.textContent.trim()).then(() => {
    const btn = items[idx].querySelector('.copy-btn');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      btn.style.background = '#d1fae5';
      btn.style.color = '#065f46';
      setTimeout(() => { btn.textContent = orig; btn.style.background = ''; btn.style.color = ''; }, 1500);
    }
  });
}

// Copy hook JSON by index
function copyHookJson(idx) {
  const cards = document.querySelectorAll('.hook-card');
  if (idx >= cards.length) return;
  const pre = cards[idx].querySelector('.hook-json');
  if (!pre) return;
  navigator.clipboard.writeText(pre.textContent.trim()).then(() => {
    const btn = cards[idx].querySelector('.copy-btn');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      btn.style.background = '#d1fae5';
      btn.style.color = '#065f46';
      setTimeout(() => { btn.textContent = orig; btn.style.background = ''; btn.style.color = ''; }, 1500);
    }
  });
}

// Copy all checked CLAUDE.md suggestions
function copyAllCheckedClaudeMd() {
  const items = document.querySelectorAll('.claude-md-item');
  const texts = [];
  items.forEach(item => {
    const cb = item.querySelector('.cmd-checkbox');
    if (cb && cb.checked) {
      const code = item.querySelector('.cmd-code');
      if (code) texts.push(code.textContent.trim());
    }
  });
  if (texts.length === 0) return;
  navigator.clipboard.writeText(texts.join('\n\n')).then(() => {
    const btn = document.querySelector('.copy-all-btn');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'Copied ' + texts.length + ' items!';
      btn.style.background = '#d1fae5';
      btn.style.color = '#065f46';
      setTimeout(() => { btn.textContent = orig; btn.style.background = ''; btn.style.color = ''; }, 2000);
    }
  });
}

// Load per-project sessions dynamically from JSON
fetch('insightful-data.json')
  .then(r => r.json())
  .then(data => {
    const container = document.getElementById('sessions-dynamic');
    if (!container) return;
    const projects = Object.entries(data.projects)
      .filter(([_, p]) => p.session_count > 0)
      .sort((a, b) => b[1].session_count - a[1].session_count);
    for (const [name, proj] of projects) {
      const sessions = (proj.sessions || []).sort((a, b) => {
        const da = a.first_timestamp || '';
        const db = b.first_timestamp || '';
        return db.localeCompare(da);
      });
      const section = document.createElement('div');
      section.className = 'collapsible-section';
      const header = document.createElement('div');
      header.className = 'collapsible-header';
      header.innerHTML = '<span class="collapsible-arrow">&#9654;</span><h3>' + name + ' (' + proj.session_count + ' sessions)</h3>';
      const content = document.createElement('div');
      content.className = 'collapsible-content';
      let html = '<div class="session-list">';
      for (const s of sessions) {
        const date = s.first_timestamp ? new Date(s.first_timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown date';
        const prompt = (s.first_prompt || s.history_prompts?.[0] || 'No prompt recorded').slice(0, 150);
        const source = s.source || 'unknown';
        const badgeClass = source === 'history' ? 'history' : source === 'jsonl' ? 'jsonl' : 'index';
        const msgs = s.user_message_count || s.history_prompt_count || 0;
        const tools = Object.values(s.tools_used || {}).reduce((sum, v) => sum + v, 0);
        const commits = s.git_commits || 0;
        const facetBadge = s.has_facet ? ' <span style="font-size:10px;background:#d1fae5;color:#065f46;padding:1px 4px;border-radius:3px;">facet</span>' : '';
        html += '<div class="session-item">';
        html += '<span class="session-date">' + date + '</span>';
        html += '<span class="source-badge ' + badgeClass + '">' + source + '</span>';
        if (msgs > 0) html += '<span style="font-size:11px;color:#64748b;margin-left:6px;">' + msgs + ' msgs</span>';
        if (tools > 0) html += '<span style="font-size:11px;color:#64748b;margin-left:4px;">' + tools + ' tools</span>';
        if (commits > 0) html += '<span style="font-size:11px;color:#64748b;margin-left:4px;">' + commits + ' commits</span>';
        html += facetBadge;
        html += '<div class="session-prompt">' + prompt.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>';
        if (s.facet && s.facet.brief_summary) {
          html += '<div style="font-size:12px;color:#64748b;margin-top:4px;font-style:italic;">' + s.facet.brief_summary + '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
      content.innerHTML = html;
      section.appendChild(header);
      section.appendChild(content);
      container.appendChild(section);
    }
    document.querySelectorAll('.collapsible-header').forEach(h => {
      h.addEventListener('click', () => {
        h.classList.toggle('open');
        h.nextElementSibling.classList.toggle('open');
      });
    });
  })
  .catch(err => {
    const el = document.getElementById('sessions-dynamic');
    if (el) el.innerHTML = '<p style="color:#ef4444;">Could not load session data. Make sure insightful-data.json is in the same directory.</p>';
  });
```

## Step 5: Open the Report

After writing the HTML file, open it using the right command for the platform:

```bash
# Detect platform and open
case "$(uname -s)" in
  Darwin) open "$HOME/.claude/usage-data/insightful-report.html" ;;
  Linux)  xdg-open "$HOME/.claude/usage-data/insightful-report.html" ;;
  MINGW*|MSYS*|CYGWIN*) start "" "$USERPROFILE/.claude/usage-data/insightful-report.html" ;;
esac
```

Tell the user the report is ready and the file path.
