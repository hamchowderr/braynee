'use strict';

// Tests for lib/vault-projects.js — the shared recursive project lookup (cp-7kfh).
// Pure Node, no deps, exit 0/1, auto-discovered by braynee-self-test section 7.

const fs = require('fs');
const os = require('os');
const path = require('path');

const V = require('./vault-projects.js');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL: ${label}`); }
};
const eq = (label, actual, expected) => {
  const good = actual === expected;
  if (!good) console.log(`  FAIL: ${label}\n         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`);
  good ? pass++ : fail++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'braynee-vaultproj-'));
const projects = path.join(root, '1. Projects');

const note = (rel, fm) => {
  const p = path.join(projects, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `---\n${fm}\n---\n\n# body\n`, 'utf8');
  return p;
};

try {
  // Flat note — the only shape the old copies could find.
  note('Flat.md', 'name: "Flat Project"\nfolder: "flat-repo"\nstatus: active');
  // Nested one level — braynee's own real shape (1. Projects/Braynee/Braynee.md).
  note('Nested/Nested.md', 'name: "Nested Project"\nfolder: "nested-repo"\nstatus: active');
  // Nested two levels — proves it is a walk, not a single extra readdir.
  note('Deep/Deeper/Deep.md', 'name: "Deep Project"\nfolder: "deep-repo"\nstatus: paused');
  // Unquoted frontmatter values must work too.
  note('Unquoted/Unquoted.md', 'name: Unquoted Project\nfolder: unquoted-repo\nstatus: active');
  // A note with no folder: field must never match or be listed.
  note('NoFolder.md', 'name: "No Folder"\nstatus: active');
  // Dot-directories are skipped.
  note('.hidden/Hidden.md', 'name: "Hidden"\nfolder: "hidden-repo"\nstatus: active');

  // ── the regression this module exists for ────────────────────────────────
  eq('finds a note nested in a project subfolder (the cp-7kfh bug)',
    V.findProjectName('nested-repo', root), 'Nested Project');
  eq('finds a note nested TWO levels deep',
    V.findProjectName('deep-repo', root), 'Deep Project');
  eq('still finds a flat note (no regression vs the old behavior)',
    V.findProjectName('flat-repo', root), 'Flat Project');

  // ── matching semantics carried over from the copies ──────────────────────
  eq('folder match is case-insensitive', V.findProjectName('NESTED-REPO', root), 'Nested Project');
  eq('handles unquoted frontmatter values', V.findProjectName('unquoted-repo', root), 'Unquoted Project');
  eq('unknown folder returns null', V.findProjectName('does-not-exist', root), null);
  eq('a note without folder: never matches', V.findProjectName('', root), null);
  eq('null folderName returns null', V.findProjectName(null, root), null);
  eq('missing vaultDir returns null', V.findProjectName('flat-repo', null), null);
  eq('nonexistent vault returns null',
    V.findProjectName('flat-repo', path.join(root, 'nope')), null);
  eq('dot-directories are skipped', V.findProjectName('hidden-repo', root), null);

  // Falls back to the filename when the note has folder: but no name:.
  note('Nameless/Nameless.md', 'folder: "nameless-repo"\nstatus: active');
  eq('falls back to the filename when name: is absent',
    V.findProjectName('nameless-repo', root), 'Nameless');

  // ── shallowest-match precedence ──────────────────────────────────────────
  // Two notes claiming the same folder: the shallower one must win, so the
  // answer is stable rather than filesystem-order dependent.
  note('Dupe.md', 'name: "Shallow Wins"\nfolder: "dupe-repo"\nstatus: active');
  note('Sub/Deeper/Dupe.md', 'name: "Deep Loses"\nfolder: "dupe-repo"\nstatus: active');
  eq('shallowest match wins when two notes claim the same folder',
    V.findProjectName('dupe-repo', root), 'Shallow Wins');

  // ── listProjectNotes ─────────────────────────────────────────────────────
  const listed = V.listProjectNotes(root);
  ok('listProjectNotes returns only notes carrying a folder: field',
    listed.length > 0 && listed.every(p => !!p.folder));
  ok('listProjectNotes excludes the no-folder note',
    !listed.some(p => p.name === 'No Folder'));
  ok('listProjectNotes includes nested notes',
    listed.some(p => p.name === 'Deep Project'));
  ok('listProjectNotes carries status through',
    (listed.find(p => p.folder === 'deep-repo') || {}).status === 'paused');
  ok('listProjectNotes on a missing vault returns []',
    Array.isArray(V.listProjectNotes(path.join(root, 'nope'))) && V.listProjectNotes(path.join(root, 'nope')).length === 0);
  ok('listProjectNotes with no vaultDir returns []', V.listProjectNotes(null).length === 0);

  // ── walkProjectNotes ─────────────────────────────────────────────────────
  const walked = V.walkProjectNotes(projects);
  ok('walkProjectNotes finds every .md at every depth', walked.length >= 8);
  ok('walkProjectNotes returns only .md files', walked.every(f => f.endsWith('.md')));
  ok('walkProjectNotes skips dot-directories',
    !walked.some(f => f.replace(/\\/g, '/').includes('/.hidden/')));
  ok('walkProjectNotes is shallowest-first',
    walked.findIndex(f => f.endsWith('Flat.md')) < walked.findIndex(f => f.endsWith('Deep.md')));
  ok('walkProjectNotes on an unreadable dir returns [] rather than throwing',
    V.walkProjectNotes(path.join(root, 'not-there')).length === 0);

  // ── robustness: a hook must never die on vault contents ──────────────────
  fs.writeFileSync(path.join(projects, 'Binary.md'), Buffer.from([0x00, 0xff, 0xfe, 0x00]));
  let threw = false;
  try { V.findProjectName('flat-repo', root); } catch { threw = true; }
  ok('a binary/garbage .md does not throw', !threw);
  eq('and lookup still succeeds past it', V.findProjectName('flat-repo', root), 'Flat Project');

  // Frontmatter beyond the head window must not be read (bounded work).
  const big = 'name: "Big"\nfolder: "big-repo"\n' + ('x: ' + 'y'.repeat(200) + '\n').repeat(60);
  note('Big.md', big);
  ok('HEAD_BYTES bounds the read', V.HEAD_BYTES > 0 && V.HEAD_BYTES <= 65536);
  eq('a note whose fields sit inside the head window still resolves',
    V.findProjectName('big-repo', root), 'Big');
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`  vault-projects.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
