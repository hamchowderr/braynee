---
name: clients
description: >
  Client relationship management. Look up client context, log engagement notes,
  track status, and prep for meetings. Use when user says "client notes", "pull up
  [client name]", "update client", "new client", "prep for [client] call",
  "log meeting", "client status".
argument-hint: [list | get CLIENT | log CLIENT TEXT | new CLIENT COMPANY | prep CLIENT]
allowed-tools: Bash(python3:*), Bash(node:*), Bash(obsidian:*)
---

# Clients Skill

Manages client context across `2. Areas/Business/<Business>/Clients/`.

## Commands

```bash
# List all active clients across businesses
python3 {baseDir}/scripts/clients.py list

# Pull up a client's full context
python3 {baseDir}/scripts/clients.py get "acme corp"

# Log a quick note to a client file
python3 {baseDir}/scripts/clients.py log "acme corp" "signed SOW, starting discovery next week"

# Create a new client scaffold (--business must match a subfolder of 2. Areas/Business/)
python3 {baseDir}/scripts/clients.py new "acme corp" --business "<YourBusinessName>"

# Prep brief for an upcoming client call (pulls recent notes + open tasks)
python3 {baseDir}/scripts/clients.py prep "acme corp"
```

## Client Folder Structure

```
2. Areas/Business/<Business>/Clients/<client-name>/
  notes.md              ← relationship context, history
  engagements/
    2026-q1-<project>/  ← one folder per engagement
      brief.md
      decisions.md
```

## Client Note Frontmatter

```yaml
---
type: client
name: Acme Corp
business: <YourBusinessName>   # must match a subfolder of 2. Areas/Business/
status: active   # active | paused | closed
rate: 150
since: 2026-01
---
```
