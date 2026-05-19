#!/usr/bin/env node
// transcript-dir.test.js — verifies the universal cwd→transcript-dir encoding
// (cp-d9g / S-1). Expectations are GROUND TRUTH: taken from real
// ~/.claude/projects/ directory names on disk. Pure Node, no deps,
// cross-platform. Exit 0 = pass, 1 = fail.

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { encodeCwd, transcriptDirFor, findTranscriptDir } = require('./transcript-dir.js');

let pass = 0, fail = 0;
const fails = [];
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; fails.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
function ok(name, cond) {
  if (cond) pass++; else { fail++; fails.push(name); }
}

// ── Ground-truth encodings (observed in real ~/.claude/projects/) ────────────
// Claude Code replaces every char NOT in [A-Za-z0-9-] with '-' — no run
// collapsing, no trimming. The OLD hardcode `C--Users-HamCh-code-<folder>`
// only ever matched one machine; these prove universality.
eq('windows ~/code (the case the old hardcode handled)',
   encodeCwd('C:\\Users\\HamCh\\code'), 'C--Users-HamCh-code');
eq('windows, different username, non-~/code',
   encodeCwd('C:\\Users\\jane\\dev\\my-app'), 'C--Users-jane-dev-my-app');
eq('windows path with a space (each space → dash)',
   encodeCwd('C:\\Users\\HamCh\\Obsidian Vault'), 'C--Users-HamCh-Obsidian-Vault');
eq('windows path with space AND dot (1. Projects → -1--Projects)',
   encodeCwd('C:\\Users\\HamCh\\Obsidian Vault\\1. Projects'),
   'C--Users-HamCh-Obsidian-Vault-1--Projects');
eq('existing literal dashes are preserved',
   encodeCwd('C:\\work\\acme-backend\\v2-final'), 'C--work-acme-backend-v2-final');
eq('posix absolute path (leading / → leading dash)',
   encodeCwd('/home/jane/work/my-app'), '-home-jane-work-my-app');
eq('posix under a non-~/code corporate root',
   encodeCwd('/srv/repos/team/service'), '-srv-repos-team-service');
eq('mixed separators each map 1:1 (no collapse)',
   encodeCwd('C:/Users\\bob//proj'), 'C--Users-bob--proj');
eq('trailing separator preserved (NOT trimmed)',
   encodeCwd('/home/jane/proj/'), '-home-jane-proj-');

// ── transcriptDirFor builds an absolute path under the given home ────────────
{
  const home = path.join(os.tmpdir(), 'd9g-home');
  eq('transcriptDirFor joins under <home>/.claude/projects',
     transcriptDirFor('/proj/app', home),
     path.join(home, '.claude', 'projects', '-proj-app'));
}

// ── findTranscriptDir: real fs, NON-~/code sandbox ──────────────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'd9g-'));
try {
  const fakeHome = path.join(sandbox, 'home');
  const fakeCwd = path.join(sandbox, 'somewhere', 'not-code', 'my proj'); // non-~/code + space
  const encoded = encodeCwd(fakeCwd);
  const tDir = path.join(fakeHome, '.claude', 'projects', encoded);

  ok('missing transcript dir → null', findTranscriptDir(fakeCwd, fakeHome) === null);

  fs.mkdirSync(tDir, { recursive: true });
  fs.writeFileSync(path.join(tDir, 'sess.jsonl'), '{}\n');

  eq('existing transcript dir resolved for a non-~/code cwd with a space',
     findTranscriptDir(fakeCwd, fakeHome), tDir);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

if (fail === 0) {
  console.log(`transcript-dir.test.js: ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`transcript-dir.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
