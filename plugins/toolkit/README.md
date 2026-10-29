# toolkit

General-purpose Claude Code skills from the braynee marketplace.

| Skill | What it does |
|---|---|
| `dev-server-manager` | Finds the full process tree of a stuck dev server, kills orphaned Node processes, frees ports and checks Postgres connection counts. Windows-first, with bash equivalents. |
| `ste-writing` | Rewrites prose into ASD-STE100 Simplified Technical English and checks the result with a bundled linter (MIT, credited in the skill). |
| `higgsfield-technique` | Prompt craft for Higgsfield image and video generation; use it next to the official `higgsfield-*` skills. |
| `resume-review` | Grades a résumé on a 100-point rubric built from career-center and recruiter research, with fixes in priority order. |

## Install

```
/plugin marketplace add hamchowderr/braynee
/plugin install toolkit@braynee
```

Skills run as `/toolkit:<name>`. On claude.ai, add the `hamchowderr/braynee` marketplace under Customize → Plugins to use them in cloud sessions.
