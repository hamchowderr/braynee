// beads-actor-sign.js
// Hook: PreToolUse (Bash + PowerShell) — sign every bd command with who ran it.
// Self-gating (no `if` field — see CLAUDE.md): exits 0 with no output unless the
// command runs bd.
//
// bd signs its audit trail with `--actor`, else $BEADS_ACTOR, else git user.name.
// Agents never set either, so every change Claude made was recorded as the
// human's. This hook adds `--actor claude` (main thread) or
// `--actor claude/<agent_type>` (inside a subagent) after each bd in command
// position, via `updatedInput`. The owner typing bd themselves still resolves to
// their git name, which is the correct answer for them.
//
// Only `updatedInput` is returned — no permission verdict — so the rewritten
// command goes through the normal permission flow; this hook never grants anything. The command still
// starts with `bd`, so allow rules like `Bash(bd *)` keep matching.
//
// No session ids are written: repos that use beads may be public.
// Claude Code only — other hosts get no rewrite (their payloads differ).

'use strict';

const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const payload = require(path.join(__dirname, 'lib', 'hook-payload.js'));
const { actorFor, signBdCommand } = require(path.join(__dirname, 'lib', 'bd-actor.js'));

const HOOK = 'beads-actor-sign';

async function main() {
  const p = await payload.read();
  if (p.host !== 'claude-code') return;
  if (p.tool !== 'Bash' && p.tool !== 'PowerShell') return;
  const input = p.raw && p.raw.tool_input;
  if (!input || typeof input.command !== 'string') return;

  const actor = actorFor(p.raw);
  const shell = p.tool === 'PowerShell' ? 'powershell' : 'bash';
  const { command, changed } = signBdCommand(input.command, actor, shell);
  if (!changed) return;

  log.info?.(HOOK, `signed bd command as ${actor}`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...input, command },
    },
  }));
}

main().catch(err => {
  // Never block a tool call over a signing failure — unsigned beats broken.
  try { log.error?.(HOOK, err && err.message); } catch {}
  process.exit(0);
});
