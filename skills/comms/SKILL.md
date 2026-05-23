---
name: comms
description: >
  Sync client communication history (email + Slack) into Obsidian weekly rollup files.
  Use when the user says "sync comms", "weekly comms", "comms for [client]", "backfill comms",
  "client communication history", "what did [client] say this week", or wants summarised weekly
  digests of conversations grouped per client and per channel.
argument-hint: [sync CLIENT [--week YYYY-Wn] | backfill CLIENT --since YYYY-MM-DD | list | contacts CLIENT]
allowed-tools: Bash(python3:*), Bash(node:*), Bash(slk:*), Bash(claude:*), Bash(obsidian:*)
---

# Comms Skill

Pulls messages from each client's configured channels (email, Slack), groups them into threads,
summarises every thread with `claude -p`, and writes one weekly rollup file plus a per-thread
detail file per client into `2. Areas/Comms/<Client>/YYYY-MM/Wn.md`.

The data model lives entirely on existing vault notes:

- **Client note** (`2. Areas/Business/*/Clients/<Client>/<file>.md`) declares its channel sources
  via a `sources:` frontmatter block (`slack_channel`, `slack_workspace_id`, `email_domains`).
- **Contact notes** (`2. Areas/Contacts/<Person>.md`) carry a unified `channels:` array; each entry
  has a `kind:` (slack, email, linkedin, phone, ...). The skill matches inbound message senders
  against these to attribute messages to a person.

Nothing about specific clients, channels, domains, or contact identifiers is hard-coded — everything
is discovered from the user's own vault at runtime. A Slack-only client works the same way as an
email-only client; the skill just iterates whatever the client's `sources:` declares.

## Commands

```bash
# Sync the current week for one client (client name matches a folder under
# 2. Areas/Business/<Business>/Clients/)
python3 {baseDir}/scripts/comms.py sync "<ClientName>"

# Sync a specific week (Wn = ordinal Monday of the month)
python3 {baseDir}/scripts/comms.py sync "<ClientName>" --week 2026-05-W3

# Backfill every week since a given date (inclusive)
python3 {baseDir}/scripts/comms.py backfill "<ClientName>" --since 2026-03-16

# List all clients with their declared sources + contact counts
python3 {baseDir}/scripts/comms.py list

# Show contacts (and the channels each carries) for one client
python3 {baseDir}/scripts/comms.py contacts "<ClientName>"
```

## Output shape

```
2. Areas/Comms/<Client Name>/
  YYYY-MM/
    Wn.md             ← weekly rollup, per-thread summaries + Week roll-up footer
  threads/
    YYYY-MM-DD-<slug>.md  ← raw thread detail (one file per thread)
```

`Wn` is the ordinal Monday of the month (`W1` = first Monday of that month). A week spans
Monday → Sunday and is filed under the month containing its Monday.

The weekly file body is produced in one `claude -p` call per week using the threads + contact
context as input; the frontmatter is generated programmatically. Re-running `sync` for the same
week overwrites the weekly file and refreshes each thread file (idempotent).

## How sender → contact resolution works

For each message pulled, the skill walks every contact note's `channels:` array. A contact matches
when one of their channels matches the sender:

- `kind: email` matches by `address`
- `kind: slack` matches by `user_id`

If no contact matches, the message is still included in the summary but attributed to the raw
sender (e.g. `Tylan Miller` for the vault owner's own outbound messages). That keeps the rollup
honest about who's talking, even before all contacts are catalogued.

## Idempotency / safety

- Re-running `sync` overwrites the weekly + thread files for that week. Manual edits to those
  files will be lost on re-sync — keep editorial notes in a sibling file (e.g. `Wn-notes.md`).
- All vault writes go through `obsidian eval` (per [[CLAUDE.md]]); never edits files directly.
- No API key consumed: summarisation uses `claude -p` which runs on the user's Claude Code OAuth
  subscription. The script refuses to run if `claude` is not on PATH.

## See also

- [[feedback_contacts_channels_additive]] — channels are listed only when present, never as empty slots
- [[feedback_braynee_no_user_specific_data]] — skill ships logic, user supplies data
- [[feedback_never_assume_api_billing]] — `claude -p` only, never `ANTHROPIC_API_KEY`
