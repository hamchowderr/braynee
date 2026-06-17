#!/usr/bin/env node
// memory-index.test.js — guards for the MEMORY.md index against CC's 200-line /
// 25KB startup-load cap (cp-1nl). Verifies description truncation, the shared
// line builder, and that resyncAllMemoryNotes regenerates an authoritative,
// deduped, truncated, stable (idempotent) index from frontmatter.
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

if (fail === 0) {
  console.log(`memory-index.test.js: ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`memory-index.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
