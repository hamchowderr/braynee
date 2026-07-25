#!/usr/bin/env node
// tasknotes-mirror.test.js — cp-ccsh.10 / B10, priority 3: this module REWRITES
// task notes in the vault (frontmatter status, completedDate, project wikilinks),
// so a regex regression silently corrupts user notes. Its own header says the
// regexes must not be changed "without updating both call sites + tests" — and
// there were no tests.
//
// VAULT_DIR is resolved at module load from getVaultRoot(), so $BRAYNEE_VAULT is
// set BEFORE the require below and every case runs against a fixture vault. The
// real vault is never read or written.
//
// `ensureMtnTask`'s create path shells out to the external `mtn` CLI and is not
// exercised; its dedupe short-circuit (the branch that decides whether to create
// at all) is.
//
// Pure Node, no deps, cross-platform. Exit 0 = pass, 1 = fail.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const fails = [];
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; fails.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
function ok(name, cond) {
  if (cond) pass++; else { fail++; fails.push(name); }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tnmirror-'));
try {
  // Must be set before the require — VAULT_DIR/TASKNOTES_DIR are module-load
  // constants.
  const VAULT = path.join(sandbox, 'vault');
  const TASKS = path.join(VAULT, '2. Areas', 'TaskNotes', 'Tasks');
  fs.mkdirSync(TASKS, { recursive: true });
  process.env.BRAYNEE_VAULT = VAULT;

  const M = require('./tasknotes-mirror.js');

  eq('VAULT_DIR honors $BRAYNEE_VAULT', M.VAULT_DIR, VAULT);
  eq('TASKNOTES_DIR is the conventional location', M.TASKNOTES_DIR, TASKS);

  // ── normalizePriority ──────────────────────────────────────────────────────
  eq('numeric 0 → critical', M.normalizePriority(0), 'critical');
  eq('numeric 1 → high', M.normalizePriority(1), 'high');
  eq('numeric 2 → medium', M.normalizePriority(2), 'medium');
  eq('numeric 3 → low', M.normalizePriority(3), 'low');
  eq('numeric 4 → low', M.normalizePriority(4), 'low');
  eq('string "0" → critical', M.normalizePriority('0'), 'critical');
  eq('P-form "P1" → high', M.normalizePriority('P1'), 'high');
  eq('lowercase p-form "p3" → low', M.normalizePriority('p3'), 'low');
  eq('already-named "high" passes through', M.normalizePriority('high'), 'high');
  eq('named value is case-insensitive', M.normalizePriority('CRITICAL'), 'critical');
  eq('undefined defaults to medium', M.normalizePriority(undefined), 'medium');
  eq('null defaults to medium', M.normalizePriority(null), 'medium');
  eq('empty string defaults to medium', M.normalizePriority(''), 'medium');
  eq('unknown word defaults to medium', M.normalizePriority('urgent-ish'), 'medium');
  eq('out-of-range number defaults to medium', M.normalizePriority(9), 'medium');
  eq('whitespace is tolerated', M.normalizePriority('  2  '), 'medium');

  // ── sanitizeTitle: these characters would break a filename ─────────────────
  eq('a colon becomes " -"', M.sanitizeTitle('B2: fix the thing'), 'B2 - fix the thing');
  eq('filesystem-illegal characters are stripped',
     M.sanitizeTitle('a/b\\c*d?e"f<g>h|i'), 'abcdefghi');
  eq('runs of whitespace collapse', M.sanitizeTitle('a    b\t\tc'), 'a b c');
  eq('leading/trailing whitespace is trimmed', M.sanitizeTitle('   padded   '), 'padded');
  eq('title is capped at 120 chars', M.sanitizeTitle('x'.repeat(200)).length, 120);
  ok('a colon followed by a space does not double the space',
     !/ {2}/.test(M.sanitizeTitle('Title: subtitle')));

  // ── projectSlugFrom: Title-Cased-With-Dashes ───────────────────────────────
  eq('kebab becomes Title-Kebab', M.projectSlugFrom('sophon-webapp'), 'Sophon-Webapp');
  eq('underscores also split', M.projectSlugFrom('my_cool_app'), 'My-Cool-App');
  eq('spaces also split', M.projectSlugFrom('my cool app'), 'My-Cool-App');
  eq('single word is capitalized', M.projectSlugFrom('braynee'), 'Braynee');
  eq('empty input yields empty string', M.projectSlugFrom(''), '');
  eq('null input yields empty string', M.projectSlugFrom(null), '');
  eq('repeated separators do not create empty segments',
     M.projectSlugFrom('a--b__c'), 'A-B-C');
  eq('existing capitals are preserved after the first letter',
     M.projectSlugFrom('myRP-build'), 'MyRP-Build');

  // ── findTasknoteForIssueId ─────────────────────────────────────────────────
  const note = (name, fm) => {
    const fp = path.join(TASKS, name);
    fs.writeFileSync(fp, `---\n${fm}\n---\n\nbody\n`, 'utf8');
    return fp;
  };

  const flow = note('flow-array.md', "title: Flow array task\ntags: [task, cp-aaa1]\nstatus: open");
  const block = note('block-list.md', "title: Block list task\ntags:\n  - task\n  - cp-bbb2\nstatus: open");
  note('unrelated.md', "title: Unrelated\ntags: [task, cp-zzz9]\nstatus: open");

  eq('finds a note whose tags are a YAML flow array',
     M.findTasknoteForIssueId('cp-aaa1'), flow);
  eq('finds a note whose tags are a YAML block list',
     M.findTasknoteForIssueId('cp-bbb2'), block);
  eq('an unknown issue id finds nothing', M.findTasknoteForIssueId('cp-nope0'), null);
  eq('a null issue id finds nothing', M.findTasknoteForIssueId(null), null);
  eq('an empty issue id finds nothing', M.findTasknoteForIssueId(''), null);

  // The tag match must be whole-token: a longer id must not match a shorter tag.
  eq('a prefix of an existing tag does not match', M.findTasknoteForIssueId('cp-aaa'), null);
  eq('an id extending an existing tag does not match', M.findTasknoteForIssueId('cp-aaa12'), null);

  // ── sub-issue fallback: parent tag + ".N" in the title ─────────────────────
  {
    const sub = note('sub-issue.md', "title: Parent work .3\ntags: [task, cp-par1]\nstatus: open");
    eq('a sub-issue id matches the parent tag plus .N in the title',
       M.findTasknoteForIssueId('cp-par1.3'), sub);
    eq('a sub-issue id with the wrong .N does not match',
       M.findTasknoteForIssueId('cp-par1.4'), null);
  }

  // ── findMtnTaskByIssueId returns a tag reference, or null ──────────────────
  eq('findMtnTaskByIssueId returns the #tag form when a note exists',
     M.findMtnTaskByIssueId('cp-aaa1'), '#cp-aaa1');
  eq('findMtnTaskByIssueId returns null when no note exists',
     M.findMtnTaskByIssueId('cp-nope0'), null);

  // ── completeMtnTaskByIssueId rewrites frontmatter ──────────────────────────
  {
    const today = new Date().toISOString().slice(0, 10);
    M.completeMtnTaskByIssueId('cp-aaa1');
    const after = fs.readFileSync(flow, 'utf8');
    ok('status is replaced with done', /^status: done$/m.test(after));
    ok('completedDate is added and quoted', new RegExp(`^completedDate: '${today}'$`, 'm').test(after));
    ok('the body survives untouched', /\nbody\n/.test(after));
    ok('other frontmatter keys survive', /^title: Flow array task$/m.test(after));
    ok('the original status line is gone', !/^status: open$/m.test(after));
    eq('exactly one status key remains', (after.match(/^status:/gm) || []).length, 1);
  }
  {
    // A note with NO status/completedDate keys must have them appended.
    const bare = note('no-status.md', 'title: Bare task\ntags: [task, cp-ccc3]');
    M.completeMtnTaskByIssueId('cp-ccc3');
    const after = fs.readFileSync(bare, 'utf8');
    ok('status is appended when absent', /^status: done$/m.test(after));
    ok('completedDate is appended when absent', /^completedDate: '/m.test(after));
    ok('the frontmatter fence is still intact',
       /^---\n[\s\S]*?\n---\n/.test(after));
  }
  {
    // Idempotency: completing twice must not duplicate keys.
    M.completeMtnTaskByIssueId('cp-ccc3');
    const after = fs.readFileSync(path.join(TASKS, 'no-status.md'), 'utf8');
    eq('completing twice leaves one status key', (after.match(/^status:/gm) || []).length, 1);
    eq('completing twice leaves one completedDate key',
       (after.match(/^completedDate:/gm) || []).length, 1);
  }
  {
    // CRLF + BOM notes are real on Windows — the regex explicitly allows both.
    const fp = path.join(TASKS, 'crlf.md');
    fs.writeFileSync(fp, '﻿---\r\ntitle: CRLF task\r\ntags: [task, cp-ddd4]\r\nstatus: open\r\n---\r\n\r\nbody\r\n', 'utf8');
    ok('a BOM + CRLF note is findable at all', M.findTasknoteForIssueId('cp-ddd4') === fp);
    M.completeMtnTaskByIssueId('cp-ddd4');
    const after = fs.readFileSync(fp, 'utf8');
    ok('a BOM + CRLF note is still updated', /status: done/.test(after));
    ok('the BOM is preserved', after.startsWith('﻿'));

    // CRLF without a BOM is the common Windows case and was equally broken.
    const fp2 = path.join(TASKS, 'crlf-nobom.md');
    fs.writeFileSync(fp2, '---\r\ntitle: CRLF no BOM\r\ntags: [task, cp-fff6]\r\nstatus: open\r\n---\r\n\r\nbody\r\n', 'utf8');
    ok('a CRLF note without a BOM is findable', M.findTasknoteForIssueId('cp-fff6') === fp2);
    M.completeMtnTaskByIssueId('cp-fff6');
    ok('a CRLF note without a BOM is updated', /status: done/.test(fs.readFileSync(fp2, 'utf8')));
  }
  {
    // Never throws on a note with no frontmatter, or a missing note.
    const noFm = path.join(TASKS, 'no-frontmatter.md');
    fs.writeFileSync(noFm, 'just a body, no frontmatter\n', 'utf8');
    // It is findable only if tagged, so this asserts the no-match path is safe.
    M.completeMtnTaskByIssueId('cp-eee5');
    eq('a note without frontmatter is left byte-identical',
       fs.readFileSync(noFm, 'utf8'), 'just a body, no frontmatter\n');
  }

  // ── ensureMtnTask dedupe short-circuit (no `mtn` invocation) ───────────────
  eq('ensureMtnTask returns the sanitized title without creating when a note exists',
     M.ensureMtnTask('cp-bbb2', 'Block list task: renamed', 'high', 'Sophon-Webapp'),
     'Block list task - renamed');
  eq('and it did not add a second note for that id',
     (fs.readdirSync(TASKS).filter(n => n === 'block-list.md')).length, 1);

  // ── run() swallows failures instead of throwing ────────────────────────────
  eq('run() returns null for a command that cannot succeed',
     M.run('this-command-does-not-exist-anywhere-xyz'), null);

  // ── a missing TaskNotes dir is handled, not thrown ────────────────────────
  {
    fs.rmSync(TASKS, { recursive: true, force: true });
    eq('a missing TaskNotes dir yields null rather than throwing',
       M.findTasknoteForIssueId('cp-aaa1'), null);
  }
} finally {
  delete process.env.BRAYNEE_VAULT;
  fs.rmSync(sandbox, { recursive: true, force: true });
}

if (fail === 0) {
  console.log(`tasknotes-mirror.test.js: ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`tasknotes-mirror.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
