#!/usr/bin/env node
'use strict';

// vault-orphan-check.mjs
// Reports notes that were DELETED from the vault but are still linked to by
// surviving notes. Read-only; prints a short block or nothing at all.
//
// Why this exists alongside the pre-commit hook (bd cp-ejkq): the pre-commit
// hook only fires for commits made through a git binary that honours hooks.
// obsidian-git auto-commits every ~10 minutes unattended and was observed
// committing a deletion WITHOUT running the hook — which is precisely the path
// that lost three Mastra reference notes on 2026-07-23. So this check ignores
// how a deletion got committed and looks only at the outcome.
//
// Stateless by design: "deleted AND still linked" is self-clearing. Restore the
// note or fix the links and it stops reporting — no marker file to drift, no
// last-seen SHA to reset, and re-running is always safe.
//
// Deliberately NOT a general dangling-link sweep: this vault treats an
// unresolved [[link]] as a valid to-write marker, so scanning every link would
// surface thousands of intentional non-hits. Restricting to paths that provably
// existed and were removed makes every hit a real regression.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { getVaultRoot } = require(path.join(here, 'lib', 'vault-root.js'));

const DEFAULT_DAYS = 14;

// Machine-generated history — a transcript mentioning a note is not a
// dependency on it, and Inbox churn is normal processing. ARCHIVED.md is the
// memory system's tombstone list: it links to retired memories ON PURPOSE, so
// a link from there is a record, not a broken dependency.
const IGNORED_REFERRERS = [
  /^2\. Areas\/Sessions\//,
  /^2\. Areas\/Changelog\//,
  /^2\. Areas\/Claude Memory\/ARCHIVED\.md$/,
];
const IGNORED_DELETIONS = [/^Inbox\//, /^2\. Areas\/Sessions\//, /^2\. Areas\/Changelog\//];

// Obsidian resolves [[Name]] by basename ANYWHERE in the vault, and also by a
// note's frontmatter `aliases:`. So a deleted file whose name is still claimed
// by a surviving note — a same-named file elsewhere, or a consolidating note
// that absorbed the name as an alias — is NOT a broken link.
//
// This matters concretely: 2. Areas/Development/AI/Mastra/_index.md declares
// aliases for Mastra Overview / Mastra Streaming / Mastra Memory API, so those
// deletions were consolidations, not losses. Without this, the check cries wolf
// and gets ignored — which is the failure mode it exists to prevent.
function claimedNames(vault) {
  const names = new Set();

  let files = [];
  try {
    files = git(['ls-files', '-z', '--', '*.md'], vault)
      .split('\0')
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return names;
  }
  for (const f of files) names.add(path.basename(f).replace(/\.md$/i, ''));

  // Collect declared aliases. Only files that actually contain an "aliases"
  // key are read, so this stays cheap on a vault with thousands of notes.
  let aliasFiles = [];
  try {
    aliasFiles = git(
      ['grep', '-l', '-z', '-E', '-e', '^(aliases|alias):', '--', '*.md'],
      vault
    )
      .split('\0')
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return names; // exit 1 = none declared
  }

  for (const f of aliasFiles) {
    let text;
    try {
      text = fs.readFileSync(path.join(vault, f), 'utf8');
    } catch {
      continue;
    }
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!fm) continue;
    // Handles both `aliases: [A, B]` and the block form with `- A` entries.
    //
    // cp-pu4q: this was a single regex ending in `(?=^\S|\Z)`. JavaScript has no
    // `\Z` escape — that is Perl/Python for end-of-string — so it matched a
    // LITERAL capital Z, and failed two ways, both silently:
    //   1. an alias containing a Z (`- Zillow`) stopped the lazy [\s\S]*? dead,
    //      leaving nothing for the per-line regex to collect;
    //   2. with no Z and no following top-level key, the lookahead never
    //      satisfied, the match failed, and the file was skipped entirely.
    // The second case covers every alias block written LAST in the frontmatter,
    // which is exactly where Obsidian's processFrontMatter appends them — so the
    // documented remedy for an orphan ("add the old name as an alias") could
    // never work. A line walk has no lookahead to get wrong.
    const lines = fm[1].split(/\r?\n/);
    let i = lines.findIndex((l) => /^(?:aliases|alias):/.test(l));
    if (i === -1) continue;

    const inline = lines[i].replace(/^(?:aliases|alias):[ \t]*/, '').trim();
    if (inline.startsWith('[')) {
      for (const part of inline.replace(/^\[|\]$/g, '').split(',')) {
        const v = part.trim().replace(/^['"]|['"]$/g, '');
        if (v) names.add(v);
      }
    } else if (inline) {
      names.add(inline.replace(/^['"]|['"]$/g, ''));
    }

    // Block form: consume `- entry` lines until the next top-level key. Running
    // off the end of the array is a normal exit, not a failure.
    for (i++; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break; // next top-level frontmatter key
      const m = /^[ \t]*-[ \t]+(.+?)[ \t]*$/.exec(lines[i]);
      if (m) names.add(m[1].replace(/^['"]|['"]$/g, ''));
      else if (lines[i].trim()) break; // indented, but not a list entry
    }
  }
  return names;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function deletedNotes(vault, days) {
  let out;
  try {
    out = git(
      ['log', `--since=${days}.days.ago`, '--diff-filter=D', '--name-only',
       '--format=%x00%H', '--', '*.md'],
      vault
    );
  } catch {
    return [];
  }

  // Records are NUL-delimited: \0<sha>\n<path>\n<path>...
  const seen = new Map(); // path -> sha that deleted it (most recent wins)
  for (const record of out.split('\0')) {
    const lines = record.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const sha = lines[0];
    for (const p of lines.slice(1)) {
      if (IGNORED_DELETIONS.some((re) => re.test(p))) continue;
      if (!seen.has(p)) seen.set(p, sha);
    }
  }

  // A path deleted then re-added (a move, or a restore) is not missing.
  const missing = [];
  for (const [p, sha] of seen) {
    if (!fs.existsSync(path.join(vault, p))) missing.push({ path: p, sha });
  }
  return missing;
}

function findReferrers(vault, missing) {
  const bases = missing.map((m) => path.basename(m.path).replace(/\.md$/i, ''));
  if (bases.length === 0) return new Map();
  const alt = bases.map(escapeRe).join('|');
  // POSIX ERE for git grep — no (?:...) here, it is a fatal error not a no-match.
  const ere = `(\\[\\[|/)(${alt})(\\]\\]|\\||#)`;

  let candidates = [];
  try {
    // -z keeps non-ASCII paths raw; without it git C-quotes them and the
    // quoted string fails to open, silently dropping referrers.
    const out = git(
      ['grep', '-l', '-z', '-E', '-e', ere, '--', '*.md',
       ':(exclude)2. Areas/Sessions/*', ':(exclude)2. Areas/Changelog/*'],
      vault
    );
    candidates = out.split('\0').map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    if (err && err.status !== 1) {
      process.stderr.write(`vault-orphan-check: git grep failed: ${err.message}\n`);
    }
    return new Map();
  }

  const re = new RegExp(`(?:\\[\\[|/)(${alt})(?:\\]\\]|\\||#)`, 'g');
  const result = new Map();
  for (const file of candidates) {
    if (IGNORED_REFERRERS.some((r) => r.test(file))) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(vault, file), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(re)) {
      const hit = missing.find(
        (x) => path.basename(x.path).replace(/\.md$/i, '') === m[1]
      );
      if (!hit) continue;
      if (!result.has(hit.path)) result.set(hit.path, new Set());
      result.get(hit.path).add(file);
    }
  }
  return result;
}

function main() {
  const vault = process.argv[2] || getVaultRoot();
  if (!vault || !fs.existsSync(path.join(vault, '.git'))) return;
  const days = Number(process.env.BRAYNEE_ORPHAN_CHECK_DAYS || DEFAULT_DAYS);

  let missing = deletedNotes(vault, days);
  if (missing.length === 0) return;

  // Drop deletions whose name a surviving note still answers to — a rename, a
  // move, or a consolidation that took the alias. Those links still resolve.
  //
  // cp-pu4q: compared case-SENSITIVELY, so a case-only rename was reported as a
  // broken link even though Obsidian resolves [[wikilinks]] case-insensitively.
  // Live example: "Dreaming ROOM AI.md" was flagged with 4 referrers while
  // "Dreaming Room AI/Dreaming Room AI.md" existed and resolved fine. Match the
  // resolver: fold case on both sides.
  const claimed = new Set([...claimedNames(vault)].map((n) => n.toLowerCase()));
  missing = missing.filter(
    (m) => !claimed.has(path.basename(m.path).replace(/\.md$/i, '').toLowerCase())
  );
  if (missing.length === 0) return;

  const referrers = findReferrers(vault, missing);
  const orphaned = missing.filter((m) => referrers.get(m.path)?.size > 0);
  if (orphaned.length === 0) return;

  const lines = [`=== DELETED NOTES STILL LINKED (last ${days}d) ===`];
  for (const o of orphaned) {
    const refs = [...referrers.get(o.path)];
    lines.push(`  ${o.path}`);
    lines.push(
      `    deleted in ${o.sha.slice(0, 8)} · still linked from ${refs.length} note(s): ${refs.slice(0, 3).join(', ')}${refs.length > 3 ? ` +${refs.length - 3} more` : ''}`
    );
    lines.push(
      `    restore: git checkout ${o.sha.slice(0, 8)}^ -- "${o.path}"`
    );
  }
  lines.push('=== END ===');
  console.log(lines.join('\n'));
}

// cp-pu4q: only run when executed directly. `claimedNames` is exported so its
// frontmatter parsing can be unit-tested, and an unguarded main() + exit(0) at
// module scope would scan the real vault and kill the importing test process.
// `import.meta.main` is not available on the Node versions braynee supports, so
// compare argv[1] to this module's own path.
const invokedDirectly =
  !!process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    main();
  } catch {
    // A startup advisory must never break session start.
  }
  process.exit(0);
}

export { claimedNames };
