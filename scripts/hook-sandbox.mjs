#!/usr/bin/env node
// hook-sandbox.mjs — scaffold a throwaway repo for LIVE hook-firing verification.
//
// Why this exists (cp-068 / cp-cpp):
//   braynee-self-test pipes synthetic stdin into each hook. That proves the JS
//   logic, but it bypasses Claude Code entirely — so it is structurally blind to
//   the CC<->hooks.json boundary: whether CC actually FIRES a hook for a real
//   tool call, and whether hookSpecificOutput.additionalContext reaches the
//   model. The `if`-field bug lived exactly there and shipped undetected.
//
//   This scaffolds a clean .beads + git repo and prints the `claude --plugin-dir`
//   command that loads the plugin straight from source — no cache copy, no
//   version bump, no restart dance. Inside that session you run real bd commands
//   and confirm firing two ways:
//     1. hook fired   -> grep ~/.claude/braynee-hooks.log (auto-assertable)
//     2. model saw it  -> launch with --debug-file and read the raw JSONL
//                         (the additionalContext delivery check; human-eyeballed)
//
// Usage:
//   node scripts/hook-sandbox.mjs                 # temp dir under the OS tmp root
//   node scripts/hook-sandbox.mjs --dir <path>    # use/create a specific dir
//   node scripts/hook-sandbox.mjs --keep          # don't print the cleanup hint
//
// Pure Node, cross-platform. Does NOT launch Claude Code (that's interactive) —
// it prepares the bed and prints the exact command to paste.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const dirArg = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : null;

function run(cmd, cmdArgs, cwd) {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8', shell: false });
  return { ok: r.status === 0, status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// 1. Sandbox dir
let dir;
if (dirArg) {
  dir = path.resolve(dirArg);
  mkdirSync(dir, { recursive: true });
} else {
  dir = mkdtempSync(path.join(tmpdir(), 'braynee-hook-sandbox-'));
}

// 2. git init + a first commit so HEAD exists on a non-main branch
//    (lets you exercise check-no-main-push / branch-name-check too).
run('git', ['init', '-q'], dir);
run('git', ['config', 'user.email', 'sandbox@braynee.test'], dir);
run('git', ['config', 'user.name', 'braynee-sandbox'], dir);
writeFileSync(path.join(dir, 'README.md'), '# braynee hook sandbox\n');
run('git', ['add', '-A'], dir);
run('git', ['commit', '-qm', 'init'], dir);
run('git', ['checkout', '-q', '-b', 'fix/hook-sandbox'], dir);

// 3. beads init. Prefer a real `bd init`; fall back to a bare .beads marker so
//    the hooks' `.beads` existsSync gate passes even if bd isn't on PATH.
let beadsMode = 'marker';
const bd = run('bd', ['init', '--shared-server', '--external', '--skip-agents', '--skip-hooks'], dir);
if (bd.ok || existsSync(path.join(dir, '.beads'))) {
  beadsMode = bd.ok ? 'bd init (shared-server, external)' : 'marker (bd init non-zero but .beads present)';
}
if (!existsSync(path.join(dir, '.beads'))) {
  mkdirSync(path.join(dir, '.beads'), { recursive: true });
  beadsMode = 'marker (bd unavailable)';
}

const log = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'braynee-hooks.log');
const debugFile = path.join(dir, 'cc-debug.jsonl');

// 4. Print the recipe.
const q = (s) => (s.includes(' ') ? `"${s}"` : s);
console.log(`
braynee hook sandbox ready
──────────────────────────────────────────────────────────────
  sandbox dir : ${dir}
  branch      : fix/hook-sandbox
  beads       : ${beadsMode}
  plugin src  : ${PLUGIN_ROOT}

LAUNCH a live CC session against the source plugin (no cache, no restart):

  cd ${q(dir)}
  claude --plugin-dir ${q(PLUGIN_ROOT)} --debug-file ${q(debugFile)}

INSIDE that session, exercise the gated hooks with REAL commands:

  bd create --title="sandbox fire test"      # expect: BEADS-TODO-MIRROR reminder reaches the model
  bd update <id> --claim                      # expect: "now in_progress" reminder
  bd close <id>                               # expect: "now closed" reminder
  echo hi                                     # expect: NO reminder (gate stays silent)
  git push                                    # expect: BLOCKED (no main push) / branch-name note

VERIFY firing (run from any shell, outside the session):

  1. hook fired   ->  grep '\\[' ${q(log)}   # look for beads-todo-reminder lines at your timestamps
  2. model saw it ->  read ${q(debugFile)}   # the additionalContext should appear in the tool_result the model received

CLEANUP when done:  delete ${q(dir)}
──────────────────────────────────────────────────────────────`);
