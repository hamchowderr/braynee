// vault-orphan-check.test.mjs — cp-pu4q.
//
// claimedNames() decides whether a deleted note's name is still answered for by
// a surviving note. Every false negative here turns a resolved link into a
// reported orphan, and the report's whole value is that every hit is real — so
// these cases are about the parser never silently giving up.
//
// Uses a real git repo because claimedNames reads through `git ls-files` and
// `git grep`; a fixture directory alone would exercise none of that.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimedNames } from './vault-orphan-check.mjs';

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`  FAIL: ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'braynee-orphan-'));
const git = (args) => execFileSync('git', args, { cwd: sandbox, encoding: 'utf8' });

try {
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);

  const write = (name, body) => {
    const p = path.join(sandbox, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  // 1. Alias block is the LAST frontmatter key. This is where Obsidian's
  //    processFrontMatter appends aliases, and the old lookahead `(?=^\S|\Z)`
  //    could never satisfy here, so the file was skipped whole.
  write('Last Key.md', '---\ntitle: Last Key\naliases:\n  - Absorbed One\n---\n\nbody\n');

  // 2. Alias containing a literal Z — `\Z` matched the letter, truncating the
  //    capture before any entry could be read.
  write('Zed.md', '---\naliases:\n  - Zillow\n  - Zoning Map\n---\n\nbody\n');

  // 3. Inline array form.
  write('Inline.md', '---\naliases: [Alpha One, "Beta Two"]\nstatus: active\n---\n\nbody\n');

  // 4. Block form followed by another top-level key — the one shape that
  //    happened to work before, kept so the fix does not regress it.
  write('Block.md', '---\naliases:\n  - Mid Block\ntags:\n  - x\n---\n\nbody\n');

  // 5. Singular `alias:` scalar.
  write('Scalar.md', "---\nalias: 'Single Name'\n---\n\nbody\n");

  // 6. A note with no aliases at all must still contribute its basename.
  write('Plain Note.md', '---\ntitle: Plain\n---\n\nbody\n');

  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fixtures']);

  const names = claimedNames(sandbox);

  ok('alias block as the LAST frontmatter key is parsed',
     names.has('Absorbed One'), [...names].join(', '));
  ok('alias containing a literal Z is parsed',
     names.has('Zillow'), [...names].join(', '));
  ok('a second entry after the Z one is also parsed',
     names.has('Zoning Map'), [...names].join(', '));
  ok('inline array form is parsed', names.has('Alpha One'));
  ok('inline array strips surrounding quotes', names.has('Beta Two'));
  ok('block form followed by another key still works', names.has('Mid Block'));
  ok('the following key is not swallowed as an alias', !names.has('x'));
  ok('singular `alias:` scalar is parsed', names.has('Single Name'));
  ok('every tracked note contributes its basename', names.has('Plain Note'));

  // The case fix lives at the call site, not in claimedNames — assert the
  // property it depends on, so a future refactor that folds case inside here
  // does not quietly make the caller's toLowerCase() a no-op guard.
  ok('claimedNames preserves original casing for display',
     names.has('Absorbed One') && !names.has('absorbed one'));

  const folded = new Set([...names].map((n) => n.toLowerCase()));
  ok('case-folded comparison matches a case-only rename',
     folded.has('plain note'), [...folded].join(', '));
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

if (fail === 0) {
  console.log(`vault-orphan-check.test.mjs: ${pass} passed, 0 failed`);
} else {
  console.error(`vault-orphan-check.test.mjs: ${pass} passed, ${fail} FAILED`);
  process.exit(1);
}
