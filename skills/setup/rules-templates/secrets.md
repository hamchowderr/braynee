---
paths:
  - "**"
  - "**/.env*"
---

# Secrets — never expose, always inject

Secret values flow **source-of-truth → process env**. They must never land in the chat — not printed by you, not pasted by the user.

## Reading / using secrets
- Inject at runtime; never read a value into tool output.
  - **{{secrets_manager}}:** {{inject_command}}
  - (Replace with your manager's runtime injection command — see examples below.)
- Never run value-printing commands (e.g. `<manager> secrets get`, `<manager> export`). Add such commands to your PreToolUse hooks' block list.
- To confirm a secret exists, print a MASK only (type / length / first chars). To find one, list folder NAMES only — never values.

## Adding / writing secrets
- Never type a raw secret literal — it lands in the transcript. Write only by reference to an already-injected var (e.g. `<manager> secrets set NEWKEY="$EXISTING"`).
- Brand-new secret values are added by the human (via your manager's UI). From then on, propagate by reference only.
- `.env` / `.env.local`: key names + placeholders (`YOUR_KEY_HERE`) only. Real values inject at runtime — never commit or write them to disk.

## Common managers — pick one and fill the placeholders above

| Manager | Inject command |
|---|---|
| **Infisical** | `infisical run --recursive --silent -- <cmd>` |
| **Doppler** | `doppler run -- <cmd>` |
| **1Password** | `op run -- <cmd>` |
| **HashiCorp Vault** | `vault kv get -format=json … \| jq … \| envsubst` (or a wrapper script) |
| **Bitwarden CLI** | `bw get item <name> \| jq -r .login.password \| pbcopy` (one-off) |
| **Agent Vault** (self-hosted broker) | wrap the CLI via the `HTTPS_PROXY` recipe so the credential is injected as a header |

> **Fill `{{secrets_manager}}` + `{{inject_command}}`** with your default. Delete the comparison table once you've picked one if you want a leaner rule.

→ Vault: `2. Areas/Development/DevOps/{{secrets_manager}}/` (setup, CLI patterns, folder inventory)
