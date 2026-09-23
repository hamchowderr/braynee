#!/usr/bin/env node
// beads-actor-sign.test.js
//
// Every bd in command position gets `--actor <who>`; bd anywhere else (quoted,
// a heredoc body, an argument to another program) is data and stays untouched.
// The first cases pin the reason the design uses a flag instead of an env
// prefix: the rewritten command must still START with `bd`, or permission rules
// like `Bash(bd *)` stop matching and every bd call starts prompting.
//
// Pure-function cases call signBdCommand; the hook cases spawn the real hook,
// because payload parsing and the output envelope are part of what can break.
//
// Pure Node, no deps, cross-platform. Exit 0 = pass, 1 = fail.

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { signBdCommand, actorFor } = require('./lib/bd-actor.js');

const HOOK = path.join(__dirname, 'beads-actor-sign.js');

let pass = 0, fail = 0;
const fails = [];
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; fails.push(`${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
}
const sign = (c, shell) => signBdCommand(c, 'claude', shell).command;

// ── still starts with bd ──
eq('plain create', sign('bd create "x" -t task'), 'bd --actor claude create "x" -t task');
eq('plain list', sign('bd list --status open'), 'bd --actor claude list --status open');

// ── chains and pipes ──
eq('cd && bd', sign('cd /repo && bd close a-1 --reason "done; really"'),
  'cd /repo && bd --actor claude close a-1 --reason "done; really"');
eq('two bds', sign('bd update a-1 --claim; bd show a-1'),
  'bd --actor claude update a-1 --claim; bd --actor claude show a-1');
eq('pipe', sign('bd list --json | node -e "x"'), 'bd --actor claude list --json | node -e "x"');
eq('for loop', sign('for i in a b; do bd close $i; done'), 'for i in a b; do bd --actor claude close $i; done');
eq('newline', sign('cd x\nbd ready'), 'cd x\nbd --actor claude ready');
eq('subshell', sign('id=$(bd create "t" --silent)'), 'id=$(bd --actor claude create "t" --silent)');

// ── wrappers and prefixes ──
eq('timeout', sign('timeout 60 bd list'), 'timeout 60 bd --actor claude list');
eq('timeout flags', sign('timeout -k 5 60 bd list'), 'timeout -k 5 60 bd --actor claude list');
eq('assignment', sign('BD_EXPORT_AUTO=false bd close a-1'), 'BD_EXPORT_AUTO=false bd --actor claude close a-1');
eq('full path exe', sign('C:/Users/x/bin/bd.exe show a-1'), 'C:/Users/x/bin/bd.exe --actor claude show a-1');

// ── data, not commands: untouched ──
eq('bd inside quotes', sign('echo "bd create x" | grep bd'), 'echo "bd create x" | grep bd');
eq('bd as an argument', sign('git log --grep bd'), 'git log --grep bd');
eq('heredoc body', sign("git commit -F - <<'EOF'\nbd create x\nEOF"), "git commit -F - <<'EOF'\nbd create x\nEOF");
eq('word containing bd', sign('bdx list; abd list'), 'bdx list; abd list');
eq('no bd', sign('npm test'), 'npm test');

// ── already signed: left exactly as written ──
eq('explicit --actor', sign('bd --actor someone close a-1'), 'bd --actor someone close a-1');
eq('BEADS_ACTOR prefix', sign('BEADS_ACTOR=x bd close a-1'), 'BEADS_ACTOR=x bd close a-1');

// ── PowerShell ──
eq('ps chain', sign("Set-Location C:\\repo; bd update a-1 --claim", 'powershell'),
  "Set-Location C:\\repo; bd --actor claude update a-1 --claim");
eq('ps call operator', sign('& bd show a-1', 'powershell'), '& bd --actor claude show a-1');
eq('ps backtick in quotes', sign('bd note a-1 "tick `" still"', 'powershell'), 'bd --actor claude note a-1 "tick `" still"');

// ── actor names ──
eq('main thread', actorFor({ session_id: 's' }), 'claude');
eq('subagent', actorFor({ agent_id: 'a1', agent_type: 'Explore' }), 'claude/Explore');
eq('plugin subagent', actorFor({ agent_id: 'a1', agent_type: 'braynee:autopilot' }), 'claude/braynee:autopilot');
eq('subagent no type', actorFor({ agent_id: 'a1' }), 'claude/subagent');
eq('--agent session (no agent_id)', actorFor({ agent_type: 'reviewer' }), 'claude');
eq('unsafe chars', actorFor({ agent_id: 'a', agent_type: 'x y;rm' }), 'claude/x-y-rm');

// ── the real hook ──
function run(input, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(input), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, MASTRA_HOOK_EVENT: '', ...env },
  });
  return r;
}
{
  const r = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'bd close a-1', description: 'Close it', timeout: 5000 } });
  eq('hook exit', r.status, 0);
  let out = {};
  try { out = JSON.parse(r.stdout); } catch {}
  const hso = out.hookSpecificOutput || {};
  eq('hook event name', hso.hookEventName, 'PreToolUse');
  eq('hook grants nothing', hso.permissionDecision, undefined);
  eq('hook command', hso.updatedInput && hso.updatedInput.command, 'bd --actor claude close a-1');
  eq('hook keeps other fields', hso.updatedInput && hso.updatedInput.description, 'Close it');
  eq('hook keeps timeout', hso.updatedInput && hso.updatedInput.timeout, 5000);
}
{
  const r = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'x', agent_type: 'general-purpose', tool_input: { command: 'bd ready' } });
  let cmd = '';
  try { cmd = JSON.parse(r.stdout).hookSpecificOutput.updatedInput.command; } catch {}
  eq('hook subagent actor', cmd, 'bd --actor claude/general-purpose ready');
}
{
  const r = run({ hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command: 'bd show a-1' } });
  let cmd = '';
  try { cmd = JSON.parse(r.stdout).hookSpecificOutput.updatedInput.command; } catch {}
  eq('hook powershell', cmd, 'bd --actor claude show a-1');
}
{
  const r = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  eq('hook silent on non-bd', r.stdout, '');
  eq('hook non-bd exit', r.status, 0);
}
{
  const r = run({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'x', content: 'bd create' } });
  eq('hook ignores Write', r.stdout, '');
}
{
  const r = run({ hook_event_name: 'PreToolUse', tool_name: 'execute_command', tool_input: { command: 'bd ready' } }, { MASTRA_HOOK_EVENT: 'PreToolUse' });
  eq('hook no rewrite on mastra-code', r.stdout, '');
}
{
  const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', windowsHide: true });
  eq('hook survives garbage stdin', r.status, 0);
}

console.log(`beads-actor-sign: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
