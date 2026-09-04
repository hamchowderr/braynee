#!/usr/bin/env node
// obsidian-cli-guard.test.js
//
// The guard must block the three Obsidian CLI shapes that fail silently, and
// leave every ordinary command alone. The case that motivated it is the one a
// naive implementation misses: `content="$(cat file)"` is SHORT as typed and only
// explodes after shell expansion, which happens after the hook has run — so a
// pure length check passes it and the CLI dies. That case is pinned first.
//
// Spawns the real hook and asserts on exit code (2 = block, 0 = allow) plus
// message text, rather than calling the pure function — the payload parsing and
// the env/ticket override are part of what can break.
//
// Pure Node, no deps, cross-platform. Exit 0 = pass, 1 = fail.

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const HOOK = path.join(__dirname, 'obsidian-cli-guard.js');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond) {
  if (cond) pass++; else { fail++; fails.push(name); }
}

function run(command, tool) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: tool || 'Bash',
      tool_input: { command },
      cwd: process.cwd(),
    }),
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, BRAYNEE_ALLOW_OBSIDIAN_CLI: '' },
  });
  return { code: r.status, err: r.stderr || '' };
}

const blocks = (cmd, tool) => run(cmd, tool).code === 2;
const allows = (cmd, tool) => run(cmd, tool).code === 0;

const OBS = 'C:/Users/HamCh/AppData/Local/Programs/Obsidian/Obsidian.com';
const big = 'x'.repeat(5000);

// ── (1) command substitution — the shape a length check cannot see ──────────
ok('blocks content=$(cat file) — short as typed, huge after expansion',
  blocks(`${OBS} create path="a/b.md" content="$(cat note.md)" overwrite silent`));
ok('blocks backtick substitution in content',
  blocks(`${OBS} create path="a/b.md" content="\`cat note.md\`" silent`));
ok('blocks ${VAR} substitution in content',
  blocks(`${OBS} create path="a/b.md" content="\${NOTE_BODY}" silent`));
ok('substitution message names the staged-file pattern',
  run(`${OBS} create path="a/b.md" content="$(cat note.md)"`).err.includes('adapter.read'));

// ── (2) literal length ──────────────────────────────────────────────────────
ok('blocks a literal content= over the safe limit',
  blocks(`${OBS} create path="a/b.md" content="${big}" silent`));
ok('length message cites the measured cliff',
  run(`${OBS} create path="a/b.md" content="${big}"`).err.includes('4000'));
ok('allows a small literal content=',
  allows(`${OBS} create path="a/b.md" content="# Title\\nHello" silent`));

// ── (3) await inside eval — hangs at ANY size ───────────────────────────────
ok('blocks an async IIFE eval',
  blocks(`${OBS} eval code="(async () => { await app.vault.create('a.md','x'); })()"`));
ok('await message explains the hang, not the size',
  run(`${OBS} eval code="(async () => { await app.vault.create('a.md','x'); })()"`).err
    .includes('never resolves'));
ok('allows the fire-and-forget eval pattern',
  allows(`${OBS} eval code="(function(){ app.vault.adapter.read('_tmp.md').then(function(c){ app.vault.create('a.md', c); }); return 'started'; })()"`));
ok('allows a trivial eval',
  allows(`${OBS} eval code="1+1"`));

// ── command position: only a real CLI invocation is examined ────────────────
ok('allows prose mentioning obsidian with a big payload',
  allows(`echo "obsidian content=${big}"`));
ok('allows an unrelated command named obsidian-something',
  allows(`npm install obsidian-dataview --save`));
ok('allows grepping for the word obsidian',
  allows(`grep -rn "obsidian" ./src`));

// ── invocation shapes that must still be caught ─────────────────────────────
ok('catches bare `obsidian` (not just Obsidian.com)',
  blocks(`obsidian create path="a/b.md" content="$(cat note.md)"`));
ok('catches it behind a timeout wrapper',
  blocks(`timeout 25 ${OBS} create path="a/b.md" content="$(cat note.md)"`));
ok('catches it after && in a chain',
  blocks(`cp a b && ${OBS} create path="a/b.md" content="$(cat note.md)"`));
ok('catches it on the PowerShell tool too',
  blocks(`${OBS} create path="a/b.md" content="$(cat note.md)"`, 'PowerShell'));

// ── ordinary CLI usage is untouched ─────────────────────────────────────────
ok('allows obsidian help', allows(`${OBS} help`));
ok('allows obsidian search', allows(`${OBS} search query="partner" limit=10`));
ok('allows a small append', allows(`${OBS} append path="a/b.md" content="\\n## New"`));
ok('allows a staging copy that mentions no CLI at all',
  allows(`cp "/scratch/note.md" "$VAULT/_tmp.md"`));

// ── override ────────────────────────────────────────────────────────────────
{
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `${OBS} create path="a/b.md" content="$(cat note.md)"` },
      cwd: process.cwd(),
    }),
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, BRAYNEE_ALLOW_OBSIDIAN_CLI: '1' },
  });
  ok('env override allows', r.status === 0);
}

// ── fail-open on junk input ─────────────────────────────────────────────────
{
  const r = spawnSync(process.execPath, [HOOK], {
    input: 'not json at all',
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, BRAYNEE_ALLOW_OBSIDIAN_CLI: '' },
  });
  ok('fails open on unparseable payload', r.status === 0);
}

console.log(`obsidian-cli-guard: ${pass} passed, ${fail} failed`);
if (fail) {
  for (const f of fails) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
process.exit(0);
