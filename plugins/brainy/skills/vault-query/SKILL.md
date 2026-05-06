---
name: vault-query
description: "This skill should be used when the user asks about vault session management, project context loading, session lifecycle, or mentions 'vault-query', session start/close/list, or project context aggregation."
---

# vault-query.mjs — Session & Project Context

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/vault-query.mjs" <command>
```

| Command | Action |
|:--------|:-------|
| `context <project>` | Load project note + sessions + stats |
| `session start --project X --goal "..." --type code` | Start session |
| `session close --project X --summary "..."` | Close active session (ALWAYS pass --project) |
| `session list --status active` | List active sessions |
| `project create --name X --repo Y --stack "..."` | Create project note |
