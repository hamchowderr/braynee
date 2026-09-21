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
// Regression: segment splitting must honour quotes. A quoted pattern containing
// escaped pipes used to split into a fragment starting with `obsidian`, blocking
// an ordinary grep. Found 2026-09-07 by tripping it live.
ok('allows a quoted grep pattern containing pipes',
  allows(`grep -rn "obsidian \\(move\\|rename\\)" --include=*.md .`));
ok('allows a quoted pattern with pipes naming a blocked subcommand',
  allows(`grep -rn "Obsidian.com \\(move\\|rename\\)" .`));
// A REAL pipe into the CLI must still be examined.
ok('still catches a genuine pipeline into the CLI',
  blocks(`cat note.md | ${OBS} move path="a.md" to="b.md"`));

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

// ── (4) move/rename hang on this Obsidian build ─────────────────────────────
// Measured 2026-09-07 on 1.13.7: every invocation hits the timeout (exit 124),
// isolated across plain vs parenthesised names, disk vs API-created files, fresh
// vs long-indexed destinations, and before vs after a full restart. `delete`
// succeeding on a parenthesised name is what rules parentheses out as the cause.
{
  ok('blocks move (plain name)',
    blocks(`${OBS} move path="Inbox/Note.md" to="Archive/Note.md"`));

  ok('blocks move (parenthesised name)',
    blocks(`${OBS} move path="Inbox/Note (2026-08-06).md" to="Archive/Note (2026-08-06).md"`));

  ok('blocks rename',
    blocks(`${OBS} rename file="Note.md" name="Renamed.md"`));

  // The commands that still work must stay untouched — parentheses and all.
  ok('allows delete, including a parenthesised name',
    allows(`${OBS} delete path="Inbox/Note (2026-08-06).md"`));

  ok('allows create',
    allows(`${OBS} create path="Folder/Note.md" content="hi"`));

  ok('allows search containing the word move',
    allows(`${OBS} search "move the files"`));

  const msg = run(`${OBS} move path="a/N.md" to="b/N.md"`).err;
  ok('names the working recipe', /app\.vault\.create/.test(msg) && /app\.vault\.trash/.test(msg));
  ok('warns renameFile is not the fix', /renameFile/.test(msg) && /no-ops/.test(msg));
  ok('documents the full-path to= requirement', /FULL destination path/.test(msg));
  // Parentheses may be MENTIONED (they were ruled out) but must never be blamed.
  ok('explicitly rules parentheses out as the cause', /NOT about parentheses/.test(msg));
  ok('cites the isolation, not a guess', /restart/.test(msg) && /exit 124/.test(msg));
}

// ── (5) property:set / property:read silently ignore path= ──────────────────
{
  ok('blocks property:set with path=',
    blocks(`${OBS} property:set name="status" value="done" path="Folder/Note.md"`));

  ok('blocks property:read with path=',
    blocks(`${OBS} property:read name="type" path="Folder/Note.md"`));

  ok('blocks property:set with file=',
    blocks(`${OBS} property:set name="status" value="done" file="Note.md"`));

  // Without a path it targets the active file, which is the documented behaviour.
  ok('allows property:set with no path/file',
    allows(`${OBS} property:set name="status" value="done"`));

  // The defect is property:*-specific — do not generalize it.
  ok('allows delete with path=',
    allows(`${OBS} delete path="Inbox/Note.md"`));

  const msg = run(`${OBS} property:set name="s" value="d" path="a/b.md"`).err;
  ok('offers processFrontMatter', /processFrontMatter/.test(msg));
  ok('property fix carries no await', !/\bawait\b/.test(msg.split('processFrontMatter')[1] || ''));
}

// ── (6) bare `obsidian` in Bash loses all stdout ────────────────────────────
{
  // Windows-only: the .com/.exe split IS the Windows packaging. On macOS/Linux
  // there is no .com shim and bare `obsidian` is correct, so the rule must not
  // fire there — braynee ships cross-platform.
  const win = process.platform === 'win32';

  ok('blocks bare obsidian in Bash (Windows only)',
    win ? blocks('obsidian read path="Folder/Note.md"', 'Bash')
        : allows('obsidian read path="Folder/Note.md"', 'Bash'));

  // PowerShell resolves .com via PATHEXT, so bare is fine there.
  ok('allows bare obsidian in PowerShell',
    allows('obsidian read path="Folder/Note.md"', 'PowerShell'));

  ok('allows Obsidian.com by full path in Bash',
    allows(`${OBS} read path="Folder/Note.md"`, 'Bash'));

  // A relative or bare `.com` is explicit enough to resolve correctly.
  ok('allows bare Obsidian.com in Bash',
    allows('Obsidian.com read path="Folder/Note.md"', 'Bash'));

  // Prose and unrelated binaries must stay untouched.
  ok('allows grep mentioning obsidian',
    allows('grep -r obsidian /c/some/dir', 'Bash'));

  if (win) {
    const msg = run('obsidian read path="a.md"', 'Bash').err;
    ok('explains the PATHEXT mechanism', /PATHEXT/.test(msg));
    ok('names the full-path fix', /Obsidian\.com/.test(msg));
  }
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
