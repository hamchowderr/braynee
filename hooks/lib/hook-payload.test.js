#!/usr/bin/env node
'use strict';

// hook-payload.test.js — unit tests for the host-neutral hook payload view.
//
// This module is what lets one hook script serve Claude Code and Mastra Code.
// A regression here is silent and severe: a guard would stop recognising the
// tool it is meant to block (fail-open), or context output would go out in a
// shape the host discards without error.

const assert = require('assert');
const P = require('./hook-payload.js');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function withMastraHost(fn) {
  const prev = process.env.MASTRA_HOOK_EVENT;
  process.env.MASTRA_HOOK_EVENT = 'PreToolUse';
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.MASTRA_HOOK_EVENT;
    else process.env.MASTRA_HOOK_EVENT = prev;
  }
}

function withClaudeHost(fn) {
  const prev = process.env.MASTRA_HOOK_EVENT;
  delete process.env.MASTRA_HOOK_EVENT;
  try {
    fn();
  } finally {
    if (prev !== undefined) process.env.MASTRA_HOOK_EVENT = prev;
  }
}

// ── host detection ───────────────────────────────────────────────────────────

test('host is derived from the env var Mastra Code injects', () => {
  withClaudeHost(() => assert.strictEqual(P.host(), 'claude-code'));
  withMastraHost(() => assert.strictEqual(P.host(), 'mastra-code'));
});

// ── tool name normalisation ──────────────────────────────────────────────────

test('Mastra Code tool names normalise to the canonical names guards check', () => {
  assert.strictEqual(P.canonicalTool('execute_command'), 'Bash');
  assert.strictEqual(P.canonicalTool('search_content'), 'Grep');
  assert.strictEqual(P.canonicalTool('find_files'), 'Glob');
  assert.strictEqual(P.canonicalTool('write_file'), 'Write');
  assert.strictEqual(P.canonicalTool('string_replace_lsp'), 'Edit');
  assert.strictEqual(P.canonicalTool('ast_smart_edit'), 'Edit');
});

test('Claude Code tool names pass through unchanged', () => {
  for (const t of ['Bash', 'Grep', 'Glob', 'Write', 'Edit', 'Read']) {
    assert.strictEqual(P.canonicalTool(t), t);
  }
});

test('delete_file stays distinct instead of masquerading as Bash', () => {
  // Folding it into Bash would make a command-grepping guard no-op on it while
  // looking like it had been checked.
  assert.strictEqual(P.canonicalTool('delete_file'), 'Delete');
});

test('unknown and empty tool names do not throw', () => {
  assert.strictEqual(P.canonicalTool('some_future_tool'), 'some_future_tool');
  assert.strictEqual(P.canonicalTool(''), '');
  assert.strictEqual(P.canonicalTool(undefined), '');
  assert.strictEqual(P.canonicalTool(null), '');
});

// ── field normalisation ──────────────────────────────────────────────────────

test('a Mastra Code PreToolUse payload reads like a Claude Code one', () => {
  const p = P.parse(
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'execute_command',
      tool_input: { command: 'git push origin main' },
      run_id: 'run-1',
      user_message: 'ship it',
      cwd: '/repo',
    }),
  );
  assert.strictEqual(p.tool, 'Bash');
  assert.strictEqual(p.hostTool, 'execute_command');
  assert.strictEqual(p.toolInput.command, 'git push origin main');
  assert.strictEqual(p.sessionId, 'run-1');
  assert.strictEqual(p.prompt, 'ship it');
  assert.strictEqual(p.cwd, '/repo');
});

test('Claude Code field names still win when both are present', () => {
  const p = P.parse(JSON.stringify({ prompt: 'cc', user_message: 'mc', session_id: 's', run_id: 'r' }));
  assert.strictEqual(p.prompt, 'cc');
  assert.strictEqual(p.sessionId, 's');
});

test('malformed or empty stdin yields a usable, inert payload', () => {
  for (const raw of ['', '{ not json', 'null', '[]', undefined]) {
    const p = P.parse(raw);
    assert.strictEqual(p.tool, '');
    assert.deepStrictEqual(p.toolInput, {});
    assert.ok(typeof p.cwd === 'string' && p.cwd.length > 0, 'cwd falls back to process.cwd()');
  }
});

test('a non-object tool_input never leaks a non-object through', () => {
  for (const bad of ['str', 42, null]) {
    assert.deepStrictEqual(P.parse(JSON.stringify({ tool_input: bad })).toolInput, {});
  }
});

// ── tool input key normalisation ─────────────────────────────────────────────

test('Mastra Code `path` is readable as `file_path`', () => {
  // A hook written against Claude Code reads file_path. On Mastra Code it would
  // otherwise read undefined and silently scan nothing.
  const p = P.parse(
    JSON.stringify({ tool_name: 'write_file', tool_input: { path: '/repo/.env', content: 'A=1' } }),
  );
  assert.strictEqual(p.tool, 'Write');
  assert.strictEqual(p.toolInput.file_path, '/repo/.env');
  assert.strictEqual(p.toolInput.path, '/repo/.env');
  assert.strictEqual(p.toolInput.content, 'A=1');
});

test('Claude Code `file_path` is readable as `path`', () => {
  const p = P.parse(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/a/b.ts' } }));
  assert.strictEqual(p.toolInput.path, '/a/b.ts');
  assert.strictEqual(p.toolInput.file_path, '/a/b.ts');
});

test('an existing spelling is never overwritten by the alias', () => {
  const p = P.parse(JSON.stringify({ tool_input: { path: '/from-path', file_path: '/from-file-path' } }));
  assert.strictEqual(p.toolInput.path, '/from-path');
  assert.strictEqual(p.toolInput.file_path, '/from-file-path');
});

test('non-string path values are not aliased', () => {
  const p = P.parse(JSON.stringify({ tool_input: { path: 42 } }));
  assert.strictEqual(p.toolInput.file_path, undefined);
});

// ── context emission ─────────────────────────────────────────────────────────

function captureStdout(fn) {
  const orig = process.stdout.write;
  let out = '';
  process.stdout.write = chunk => {
    out += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

test('context is emitted as plain text on Claude Code', () => {
  withClaudeHost(() => {
    assert.strictEqual(captureStdout(() => P.emitContext('hello')), 'hello');
  });
});

test('context is emitted as additionalContext JSON on Mastra Code', () => {
  withMastraHost(() => {
    const out = captureStdout(() => P.emitContext('hello'));
    assert.deepStrictEqual(JSON.parse(out), { additionalContext: 'hello' });
  });
});

test('empty context writes nothing on either host', () => {
  withClaudeHost(() => assert.strictEqual(captureStdout(() => P.emitContext('')), ''));
  withMastraHost(() => assert.strictEqual(captureStdout(() => P.emitContext('')), ''));
});

// ── context channel per event ────────────────────────────────────────────────

test('Claude Code UserPromptSubmit context is plain stdout', () => {
  assert.strictEqual(P.contextPayload('hi', 'UserPromptSubmit', 'claude-code'), 'hi');
  assert.strictEqual(P.contextPayload('hi', undefined, 'claude-code'), 'hi');
});

test('Claude Code PreToolUse context needs the hookSpecificOutput envelope', () => {
  // Plain stdout from an exit-0 PreToolUse hook is NOT added to context on
  // Claude Code, so emitting it plainly would lose the text with no error.
  const parsed = JSON.parse(P.contextPayload('hi', 'PreToolUse', 'claude-code'));
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(parsed.hookSpecificOutput.additionalContext, 'hi');
});

test('Mastra Code context is flat additionalContext for every event', () => {
  for (const ev of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', undefined]) {
    const parsed = JSON.parse(P.contextPayload('hi', ev, 'mastra-code'));
    assert.strictEqual(parsed.additionalContext, 'hi');
    assert.strictEqual(parsed.hookSpecificOutput, undefined, 'must not nest the Claude Code envelope');
  }
});

// ── denial protocol ──────────────────────────────────────────────────────────

test('Claude Code denial uses the permissionDecision object on stdout', () => {
  const d = P.denyPayload('nope', 'PreToolUse', 'claude-code');
  assert.strictEqual(d.stream, 'stdout');
  assert.strictEqual(d.exitCode, 0);
  const parsed = JSON.parse(d.text);
  assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(parsed.hookSpecificOutput.permissionDecisionReason, 'nope');
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
});

test('Mastra Code denial uses exit 2 + stderr, the only thing it blocks on', () => {
  // Emitting the Claude Code JSON here would be discarded and the call allowed —
  // a guard that silently stops guarding.
  const d = P.denyPayload('nope', 'PreToolUse', 'mastra-code');
  assert.strictEqual(d.stream, 'stderr');
  assert.strictEqual(d.exitCode, 2);
  assert.strictEqual(d.text, 'nope');
});

test('denial always carries a reason, even when given none', () => {
  for (const h of ['claude-code', 'mastra-code']) {
    const d = P.denyPayload('', 'PreToolUse', h);
    assert.ok(d.text && d.text.length > 0);
  }
});

// ── runner ───────────────────────────────────────────────────────────────────
let passed = 0,
  failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name}\n  ${err.message}`);
    failed++;
  }
}
console.log(`hook-payload: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
