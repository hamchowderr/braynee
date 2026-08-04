'use strict';

// hook-payload.js — one host-neutral view of a hook invocation.
//
// braynee's hooks are invoked by more than one coding agent, and the hosts
// disagree on three things. This module is the single place that knows about
// those differences, so individual hooks stay written once (cp-62k, cp-3o3g.3):
//
//   1. Tool names.   Claude Code says Bash/Read/Write/Edit/Glob/Grep.
//                    Mastra Code says execute_command/view/write_file/
//                    string_replace_lsp/find_files/search_content.
//   2. Field names.  Claude Code sends `prompt` and `session_id`.
//                    Mastra Code sends `user_message` and `run_id`.
//   3. Stdout.       Claude Code injects plain stdout into the model's context.
//                    Mastra Code parses stdout as JSON and reads
//                    `additionalContext`; anything else is silently discarded.
//
// Claude Code's vocabulary is the canonical one here purely because braynee's
// hooks were written against it first — `tool` is always the canonical name and
// `hostTool` is whatever the host actually called it.
//
// Blocking is NOT a difference: both hosts treat exit code 2 plus a stderr
// message as "deny this tool call", so `block()` is the same on either.

const MC_TO_CANONICAL = {
  execute_command: 'Bash',
  view: 'Read',
  write_file: 'Write',
  string_replace_lsp: 'Edit',
  ast_smart_edit: 'Edit',
  find_files: 'Glob',
  search_content: 'Grep',
  get_process_output: 'BashOutput',
  kill_process: 'KillShell',
  // No Claude Code equivalent — kept distinct rather than folded into Bash, so a
  // guard that cares about deletion can opt in explicitly instead of a guard
  // that greps a `command` field silently treating it as a no-op.
  delete_file: 'Delete',
  mkdir: 'Mkdir',
  file_stat: 'Stat',
  lsp_inspect: 'LspInspect',
};

// Tool INPUT keys differ too, not just tool names. Claude Code's file tools take
// `file_path`; Mastra Code's workspace tools take `path` (verified against the
// shipped zod schemas in @mastra/core/workspace). `content` is the same on both.
//
// A guard that reads only one spelling does not error on the other host — it
// reads undefined and quietly does nothing. For a secret scanner that is the
// worst possible failure, so both spellings are always populated when either is
// present, and hooks can keep using whichever they were written against.
function normaliseToolInput(ti) {
  if (!ti || typeof ti !== 'object') return {};
  const out = { ...ti };
  if (out.file_path == null && typeof out.path === 'string') out.file_path = out.path;
  if (out.path == null && typeof out.file_path === 'string') out.path = out.file_path;
  return out;
}

// Mastra Code's hook executor injects MASTRA_HOOK_EVENT into the child env
// (sdk/src/hooks/executor.ts). That is the host's own signal, so detection needs
// no guesswork and no configuration.
function host() {
  return process.env.MASTRA_HOOK_EVENT ? 'mastra-code' : 'claude-code';
}

function canonicalTool(name) {
  if (typeof name !== 'string' || !name) return '';
  return MC_TO_CANONICAL[name] || name;
}

// Never throws: a hook that dies on malformed stdin would block the user's turn.
function parse(raw) {
  let d = {};
  try {
    const parsed = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object') d = parsed;
  } catch {
    d = {};
  }

  const hostTool = typeof d.tool_name === 'string' ? d.tool_name : '';
  const toolInput = normaliseToolInput(d.tool_input);

  return {
    host: host(),
    event: d.hook_event_name || process.env.MASTRA_HOOK_EVENT || '',
    tool: canonicalTool(hostTool),
    hostTool,
    toolInput,
    cwd: typeof d.cwd === 'string' && d.cwd ? d.cwd : process.cwd(),
    prompt: d.prompt || d.user_message || '',
    sessionId: d.session_id || d.run_id || '',
    raw: d,
  };
}

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => {
      buf += c;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

async function read() {
  return parse(await readStdin());
}

/**
 * Emit text intended for the model's context, in whatever shape this host reads.
 *
 * `event` matters on Claude Code and is not optional in practice. Claude Code
 * injects plain stdout for UserPromptSubmit, but for PreToolUse (and the other
 * tool events) an exit-0 hook's plain stdout is NOT added to context — that
 * requires the hookSpecificOutput channel. Passing the wrong shape loses the
 * text with no error. Mastra Code wants a flat {additionalContext} for every
 * event and ignores the Claude Code envelope entirely.
 *
 * Caveat: as of mastracode 0.32.4 the TUI never reads a hook's additionalContext,
 * so on that host this is currently inert. Emitting the right shape anyway costs
 * nothing and starts working the moment they wire it up — whereas emitting the
 * wrong shape is silently dropped, which is worse.
 */
function contextPayload(text, event, hostName = host()) {
  const value = String(text);
  if (hostName === 'mastra-code') return JSON.stringify({ additionalContext: value });
  if (event && event !== 'UserPromptSubmit') {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: value } });
  }
  return value;
}

function emitContext(text, event) {
  if (!text) return;
  process.stdout.write(contextPayload(text, event));
}

/**
 * Deny the tool call the simple way. exit 2 + stderr is honoured by BOTH hosts,
 * so this is the portable primitive and what new hooks should use.
 */
function block(message) {
  process.stderr.write(String(message || 'Blocked by braynee hook'));
  process.exit(2);
}

/**
 * Shape of a denial for the current host. Pure, so it can be tested without
 * spawning a process — `deny()` is the thin wrapper that performs it.
 *
 * Claude Code understands a richer JSON decision object
 * (`hookSpecificOutput.permissionDecision`). Mastra Code does NOT: its executor
 * blocks only on exit code 2, and any JSON it cannot use is discarded. A hook
 * that denies purely via the Claude Code object therefore blocks on Claude Code
 * and silently permits on Mastra Code — which for a secret guard means it stops
 * guarding without ever reporting a failure.
 */
function denyPayload(reason, event = 'PreToolUse', hostName = host()) {
  const text = String(reason || 'Blocked by braynee hook');
  if (hostName === 'mastra-code') {
    return { stream: 'stderr', text, exitCode: 2 };
  }
  return {
    stream: 'stdout',
    text: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: 'deny',
        permissionDecisionReason: text,
      },
    }),
    exitCode: 0,
  };
}

/** Deny using the richest form this host understands. */
function deny(reason, event = 'PreToolUse') {
  const { stream, text, exitCode } = denyPayload(reason, event);
  process[stream].write(text);
  process.exit(exitCode);
}

module.exports = {
  parse,
  read,
  readStdin,
  emitContext,
  contextPayload,
  block,
  deny,
  denyPayload,
  canonicalTool,
  normaliseToolInput,
  host,
  MC_TO_CANONICAL,
};
