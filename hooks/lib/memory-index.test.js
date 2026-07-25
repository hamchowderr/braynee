#!/usr/bin/env node
// memory-index.test.js — guards for the MEMORY.md index against CC's 200-line /
// 25KB startup-load cap (cp-1nl). Verifies description truncation, the shared
// line builder, and that resyncAllMemoryNotes regenerates an authoritative,
// deduped, truncated, stable (idempotent) index from frontmatter.
//
// The last two blocks measure the ASSEMBLED line and the whole regenerated FILE
// (cp-ccsh.1 / B2). Capping only the description let the B1 overflow bug ship
// past a green test — assert on what gets written, not on truncateDesc alone.
// Pure Node, no deps, cross-platform. Exit 0 = pass, 1 = fail.

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const {
  truncateDesc,
  buildIndexLine,
  typeToSection,
  parseFrontmatter,
  resyncAllMemoryNotes,
  MAX_DESC_LEN,
  MAX_LINE_LEN,
  MIN_DESC_BUDGET,
} = require('./memory-index.js');

let pass = 0, fail = 0;
const fails = [];
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; fails.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
function ok(name, cond) {
  if (cond) pass++; else { fail++; fails.push(name); }
}

// ── truncateDesc ─────────────────────────────────────────────────────────────
eq('cap constant is 130', MAX_DESC_LEN, 130);
eq('short description is unchanged', truncateDesc('a short note'), 'a short note');
eq('empty/undefined → empty string', truncateDesc(undefined), '');
{
  const long = 'x'.repeat(400);
  const out = truncateDesc(long);
  ok('long description is truncated to <= MAX_DESC_LEN', out.length <= MAX_DESC_LEN);
  ok('truncated description ends with ellipsis', out.endsWith('…'));
}

// ── buildIndexLine ───────────────────────────────────────────────────────────
eq('line with name + description',
   buildIndexLine({ name: 'foo', description: 'does a thing' }, 'foo.md'),
   '- [foo](foo.md) — does a thing');
eq('line falls back to filename when no name',
   buildIndexLine({ description: 'd' }, 'bar-baz.md'),
   '- [bar-baz](bar-baz.md) — d');
eq('line with no description omits the dash',
   buildIndexLine({ name: 'n' }, 'n.md'),
   '- [n](n.md)');

// ── parseFrontmatter: flat AND nested metadata.type ─────────────────────────
eq('flat top-level type',
   parseFrontmatter('---\nname: a\ntype: feedback\n---\nbody').type, 'feedback');
eq('nested metadata.type (older files)',
   parseFrontmatter('---\nname: a\nmetadata:\n  node_type: memory\n  type: project\n---\nbody').type,
   'project');
eq('nested metadata with trailing space after key',
   parseFrontmatter('---\nname: a\nmetadata: \n  type: reference\n---\nbody').type,
   'reference');
eq('top-level type wins over nested',
   parseFrontmatter('---\ntype: user\nmetadata:\n  type: feedback\n---\nbody').type, 'user');
eq('quoted description preserved',
   parseFrontmatter('---\ndescription: "hi there"\n---\nbody').description, '"hi there"');

// ── typeToSection ────────────────────────────────────────────────────────────
eq('user → User', typeToSection('user'), 'User');
eq('feedback → Feedback', typeToSection('feedback'), 'Feedback');
eq('project → Projects', typeToSection('project'), 'Projects');
eq('unknown → References (default)', typeToSection('whatever'), 'References');

// ── resyncAllMemoryNotes: regenerate from frontmatter ────────────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cp1nl-'));
try {
  const memDir = sandbox;
  const settings = { autoMemoryDirectory: memDir };

  // Real memory files carry a FLAT top-level `type:` (see vault Claude Memory/);
  // parseFrontmatter only reads flat top-level keys.
  const fmFile = (name, type, desc) =>
    fs.writeFileSync(path.join(memDir, name),
      `---\nname: ${name.replace(/\.md$/, '')}\ndescription: ${desc}\ntype: ${type}\n---\n\nbody\n`);

  fmFile('user_alpha.md', 'user', 'who the user is');
  fmFile('feedback_long.md', 'feedback', 'L'.repeat(400)); // overlong → must truncate
  fmFile('project_zeta.md', 'project', 'an ongoing build');
  fmFile('reference_mid.md', 'reference', 'a pointer to docs');

  // A deliberately messy pre-existing index: preamble + a DUPLICATE entry for
  // feedback_long.md in two sections + an overlong handwritten line.
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'),
    '# Claude Memory Index\n\n' +
    '## Feedback\n' +
    '- [feedback_long](feedback_long.md) — ' + 'L'.repeat(400) + '\n' +
    '## References\n' +
    '- [feedback_long dup](feedback_long.md) — duplicate that must be removed\n');

  const s1 = resyncAllMemoryNotes(settings);
  eq('scanned all 4 memory files', s1.scanned, 4);

  const content = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8');
  const lines = content.split('\n');

  eq('preamble title preserved as first line', lines[0], '# Claude Memory Index');

  // one line per file — feedback_long.md appears exactly once now
  const occurrences = (content.match(/\(feedback_long\.md\)/g) || []).length;
  eq('cross-section duplicate collapsed to a single entry', occurrences, 1);

  // truncation: no index line's description pushes it absurdly long; the long
  // entry must be truncated + ellipsis.
  const longLine = lines.find(l => l.includes('(feedback_long.md)'));
  ok('long entry exists', !!longLine);
  ok('long entry truncated (well under the 400-char original)', longLine.length < 220);
  ok('long entry ends with ellipsis', longLine.trimEnd().endsWith('…'));

  // sections present and in canonical order
  const idxUser = content.indexOf('## User');
  const idxFeedback = content.indexOf('## Feedback');
  const idxProjects = content.indexOf('## Projects');
  const idxRefs = content.indexOf('## References');
  ok('all four sections present', idxUser >= 0 && idxFeedback >= 0 && idxProjects >= 0 && idxRefs >= 0);
  ok('sections in SECTION_ORDER order',
     idxUser < idxFeedback && idxFeedback < idxProjects && idxProjects < idxRefs);

  // reference_mid is type reference → must be under References, not elsewhere
  ok('reference entry homed under References',
     content.indexOf('(reference_mid.md)') > idxRefs);

  // idempotency: a second resync of the now-clean dir writes nothing
  const before = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8');
  const s2 = resyncAllMemoryNotes(settings);
  const after = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8');
  eq('second run is a no-op (added=0)', s2.added, 0);
  eq('second run is a no-op (updated=0)', s2.updated, 0);
  eq('second run leaves content byte-identical', after, before);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

// ── whole-ASSEMBLED-LINE budget (cp-ccsh.1 / B2) ─────────────────────────────
// The pre-existing truncateDesc assertions above measure the DESCRIPTION in
// isolation, which is why the B1 overflow bug shipped past a green test: an
// index line is `- [{name}]({file}) — {desc}`, so capping only {desc} leaves
// {name} and {file} unbounded. Measured on the real 126-note folder: 121 of 126
// lines exceeded 130 chars, the longest was 263, and a regen came out at 26,404
// bytes against a ~24,985-byte startup-load cap.
//
// These assertions therefore measure the assembled lines in the file
// resyncAllMemoryNotes actually writes. Fixture sizes are load-bearing — built
// with padEnd so a future edit cannot quietly shrink them back below the cap.
{
  // Floor from buildIndexLine's budget: a prefix long enough to eat the whole
  // line budget still gets a minimum description slice, so such a line can
  // exceed MAX_LINE_LEN. Shortening those `name:` values is the separate B1a
  // data fix — the invariant below accounts for the floor rather than ignoring it.
  const FLOOR = typeof MIN_DESC_BUDGET === 'number' ? MIN_DESC_BUDGET : 24;
  const CAP = typeof MAX_LINE_LEN === 'number' ? MAX_LINE_LEN : 150;

  eq('MAX_LINE_LEN is exported and caps the whole line', MAX_LINE_LEN, 150);

  const sandbox2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsh1-'));
  try {
    const settings = { autoMemoryDirectory: sandbox2 };
    const write = (file, memName, type, desc) =>
      fs.writeFileSync(path.join(sandbox2, file),
        `---\nname: ${memName}\ndescription: ${desc}\ntype: ${type}\n---\n\nbody\n`);

    // Budget-governed case: a 44-char filename + 72-char name → a 125-char
    // prefix, leaving real room for a description. Before B1 this assembled to
    // 255 chars (125 + a 130-char description).
    const file1 = 'feedback_assembled_line_budget_regression.md';
    const name1 = 'feedback-whole-line-budget-not-just-desc-'.padEnd(72, 'x');
    write(file1, name1, 'feedback', 'D'.repeat(400));

    // Prefix-dominated case: an 85-char name pushes the prefix past the budget
    // on its own, so only the FLOOR slice of description may survive.
    const file2 = 'feedback_prefix_dominated_overflow.md';
    const name2 = 'feedback-a-name-so-long-it-eats-the-entire-line-budget-'.padEnd(85, 'y');
    write(file2, name2, 'feedback', 'E'.repeat(400));

    write('user_short.md', 'user_short', 'user', 'who the user is');

    const s = resyncAllMemoryNotes(settings);
    eq('resync scanned all 3 fixtures', s.scanned, 3);

    const written = fs.readFileSync(path.join(sandbox2, 'MEMORY.md'), 'utf8');
    const indexLines = written.split('\n').filter(l => l.startsWith('- ['));
    eq('all 3 fixtures produced an index line', indexLines.length, 3);

    // The invariant: every assembled line respects the whole-line budget, and a
    // prefix that already exceeds it concedes only the floor slice.
    const overflowing = indexLines.filter(l => {
      const cut = l.indexOf(' — ');
      const prefixLen = cut === -1 ? l.length : cut + 3;
      return l.length > Math.max(CAP, prefixLen + FLOOR);
    });
    eq('no assembled index line exceeds the whole-line budget', overflowing.length, 0);
    if (overflowing.length) {
      fails.push(`  longest overflowing line was ${Math.max(...overflowing.map(l => l.length))} chars`);
    }

    const line1 = indexLines.find(l => l.includes(`(${file1})`));
    ok('budget-governed entry exists', !!line1);
    ok(`budget-governed line fits the cap (was ${line1 ? line1.length : '?'} chars, cap ${CAP})`,
       !!line1 && line1.length <= CAP);

    const line2 = indexLines.find(l => l.includes(`(${file2})`));
    ok('prefix-dominated entry exists', !!line2);
    ok('prefix-dominated entry keeps only the floor description slice',
       !!line2 && line2.length <= line2.indexOf(' — ') + 3 + FLOOR);

    // A short-prefix note must NOT be over-truncated by the new budget math.
    ok('short entry keeps its full description',
       written.includes('- [user_short](user_short.md) — who the user is'));
  } finally {
    fs.rmSync(sandbox2, { recursive: true, force: true });
  }
}

// ── whole-FILE budget: a realistic 126-note folder stays loadable ────────────
// B1's acceptance criterion, measured: the real folder regenerated to 26,404
// bytes against CC's ~24,985-byte (25KB) startup-load cap.
{
  const CAP_BYTES = 24985;
  const sandbox3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsh1b-'));
  try {
    const settings = { autoMemoryDirectory: sandbox3 };
    for (let i = 0; i < 126; i++) {
      const file = `feedback_synthetic_memory_note_${String(i).padStart(3, '0')}.md`;
      const memName = `feedback-synthetic-memory-note-${String(i).padStart(3, '0')}-`.padEnd(80, 'z');
      fs.writeFileSync(path.join(sandbox3, file),
        `---\nname: ${memName}\ndescription: ${'F'.repeat(300)}\ntype: feedback\n---\n\nbody\n`);
    }
    const s = resyncAllMemoryNotes(settings);
    eq('resync scanned all 126 synthetic notes', s.scanned, 126);
    const bytes = fs.statSync(path.join(sandbox3, 'MEMORY.md')).size;
    ok(`126 notes with 80-char names regenerate under the 25KB cap (got ${bytes} bytes)`,
       bytes < CAP_BYTES);
  } finally {
    fs.rmSync(sandbox3, { recursive: true, force: true });
  }
}

if (fail === 0) {
  console.log(`memory-index.test.js: ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`memory-index.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
