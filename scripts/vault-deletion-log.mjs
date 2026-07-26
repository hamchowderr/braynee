#!/usr/bin/env node
'use strict';

// vault-deletion-log.mjs
// Git hook helper: run from the VAULT repo's `pre-commit`. Records every
// staged file deletion into today's vault changelog and shouts when a single
// commit removes an unusual number of files.
//
// Why this exists (bd cp-ejkq): hooks/vault-changelog.js gates on
// `tool_name === 'Write' | 'Edit'`, so deletions are structurally invisible to
// it. Worse, a PostToolUse hook can never see the full picture — a note
// trashed by hand in Obsidian, by `rm`, or by the `obsidian` CLI never touches
// Claude Code at all. The one chokepoint EVERY deletion passes through,
// whatever removed it, is the vault's git commit. So we log there.
//
// This closes a real incident: 2026-07-23 commit 9ce78b74 deleted three
// curated Mastra reference notes (Deployment / Channels / Agent Skills) and
// obsidian-git auto-committed AND auto-pushed it within 10 minutes. Nothing
// logged it; inbound wikilinks dangled for two days.
//
// Non-blocking by contract: ALWAYS exits 0. A backup loop that runs unattended
// every 10 minutes must never be jammed by its own audit logging.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Repo internals and tool state — churn, not knowledge. Deleting these is
// routine and logging them would bury the signal.
const SKIP_PATTERNS = [
  /^\.git\//,
  /^\.beads\//,
  /^\.obsidian\//,
  /^\.trash\//,
  /^\.smart-env\//,
  /^\.qmd\//,
];

// More than this many deletions in ONE commit reads as a sweep, not an edit.
const DEFAULT_ALERT_THRESHOLD = 3;

// Notes still pointed at by other notes. A count threshold alone would have
// missed the incident that motivated this script (3 files — under any sane
// threshold), but every one of them had live inbound wikilinks. THAT is the
// precise signal for "you just deleted something other notes depend on".
//
// Deliberately NOT a general dangling-link sweep: this vault treats an
// unresolved [[link]] as a valid to-write marker, so scanning the whole vault
// would return thousands of intentional non-hits. Checking only files being
// deleted right now — files that demonstrably existed a moment ago — makes
// every hit a true regression.
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches [[Base]], [[Base|alias]], [[Base#Heading]], and the path-qualified
// [[2. Areas/.../Base]] form Obsidian also accepts.
function linkRe(bases, flags) {
  const alt = bases.map(escapeRe).join('|');
  return new RegExp(`(?:\\[\\[|/)(${alt})(?:\\]\\]|\\||#)`, flags);
}

// Same shape for `git grep -E`, which is POSIX ERE and has no `(?:...)`.
// Passing the JS source straight through fails with "Invalid preceding regular
// expression" — and because that surfaces as a non-zero exit it looks exactly
// like "no matches", silently disabling the check. Keep these two in sync.
function linkPatternERE(bases) {
  const alt = bases.map(escapeRe).join('|');
  return `(\\[\\[|/)(${alt})(\\]\\]|\\||#)`;
}

// One git grep for ALL deleted notes, then attribute hits by reading only the
// handful of candidate files. Per-note probing was ~0.9s per pattern against
// 8.6k tracked notes — with five patterns per note that put a bulk delete at
// 30s+, unacceptable for a hook on an unattended 10-minute auto-commit loop.
function findInboundLinks(deletedPaths) {
  const result = new Map();
  const bases = deletedPaths.map((p) => path.basename(p).replace(/\.md$/i, ''));
  if (bases.length === 0) return result;

  let candidates = [];
  try {
    const out = execFileSync(
      'git',
      [
        'grep', '--cached', '-l', '-z', '-E', '-e', linkPatternERE(bases),
        '--', '*.md',
        // Machine-generated history, not live references. A transcript that
        // once mentioned a note isn't a dependency on it, and counting them
        // would drown the real referrers.
        ':(exclude)2. Areas/Sessions/*',
        ':(exclude)2. Areas/Changelog/*',
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    );
    // -z keeps paths raw and NUL-separated. Without it git applies C-style
    // quoting to any path with non-ASCII (this vault is full of em-dashes),
    // and the quoted string then fails to open — silently dropping referrers.
    candidates = out.split('\0').map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    // Exit 1 is "no matches" — the common, healthy case. Anything else (bad
    // pattern, git failure) means the check did NOT run; say so out loud rather
    // than reporting a reassuring zero.
    if (err && err.status !== 1) {
      process.stderr.write(
        `\n  braynee: inbound-link check FAILED to run — deletions are logged but\n` +
          `  orphaned-reference detection was skipped. ${String(err.stderr || err.message).trim()}\n\n`
      );
    }
    return result;
  }

  const deleted = new Set(deletedPaths);
  const re = linkRe(bases, 'g');
  for (const file of candidates) {
    // A note being deleted in this same commit isn't a surviving referrer.
    if (deleted.has(file)) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // vanished under us — nothing to report
    }
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const target = deletedPaths.find(
        (p) => path.basename(p).replace(/\.md$/i, '') === m[1]
      );
      if (!target) continue;
      if (!result.has(target)) result.set(target, new Set());
      result.get(target).add(file);
    }
  }
  return result;
}

function stagedDeletions() {
  // -z (NUL-separated) so paths with spaces, parentheses, or non-ASCII survive
  // intact — the vault is full of them ("Mastra Agent Skills (Official).md").
  // Without it git applies C-style quoting and the paths come back mangled.
  const raw = execFileSync(
    'git',
    ['diff', '--cached', '--name-status', '--diff-filter=D', '-z'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );

  // Format is repeating `status\0path\0`. --diff-filter=D means every status
  // is a bare "D", so we take the odd-indexed fields as paths.
  const fields = raw.split('\0').filter((f) => f.length > 0);
  const paths = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    paths.push(fields[i + 1]);
  }
  return paths.filter((p) => !SKIP_PATTERNS.some((re) => re.test(p)));
}

function main() {
  let deletions;
  try {
    deletions = stagedDeletions();
  } catch {
    return; // not a git repo, git missing, whatever — never block the commit
  }
  if (deletions.length === 0) return;

  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const changelogDir = path.join(repoRoot, '2. Areas', 'Changelog');
  const changelogPath = path.join(changelogDir, `${dateStr}.md`);

  fs.mkdirSync(changelogDir, { recursive: true });
  if (!fs.existsSync(changelogPath)) {
    // Same header vault-changelog.js writes — either may create the day's file.
    fs.writeFileSync(
      changelogPath,
      `---\ntype: changelog\ndate: ${dateStr}\n---\n\n` +
        `# Changelog ${dateStr}\n\n` +
        `Auto-logged file edits from Claude Code sessions. One line per Write/Edit.\n\n`,
      'utf8'
    );
  }

  let out = '';
  for (const p of deletions) {
    out += `- ${timeStr} · delete · \`${p}\`\n`;
  }

  // Orphaned-reference check runs on every deletion, independent of count —
  // one depended-on note dying matters more than ten throwaways dying.
  const inbound = findInboundLinks(deletions.filter((p) => /\.md$/i.test(p)));
  const orphaned = [];
  for (const p of deletions) {
    const links = inbound.get(p);
    if (links && links.size > 0) orphaned.push({ path: p, links: [...links] });
  }

  for (const { path: p, links } of orphaned) {
    out +=
      `\n> [!warning] Deleted note still has ${links.length} inbound link${links.length === 1 ? '' : 's'} — \`${path.basename(p)}\`\n` +
      `> Those links now dangle. Restore the note, or update them:\n`;
    for (const l of links) out += `> - \`${l}\`\n`;
    out += '\n';
  }

  if (orphaned.length > 0) {
    const total = orphaned.reduce((n, o) => n + o.links.length, 0);
    process.stderr.write(
      `\n  braynee: deleting ${orphaned.length} note(s) that ${total} other note(s) still link to:\n` +
        orphaned.map((o) => `    - ${o.path} (${o.links.length} inbound)`).join('\n') +
        `\n  Those wikilinks will dangle. Verify this was intentional.\n\n`
    );
  }

  const threshold = Number(
    process.env.BRAYNEE_DELETION_ALERT_THRESHOLD || DEFAULT_ALERT_THRESHOLD
  );

  if (deletions.length > threshold) {
    // The commit hasn't happened yet, so its SHA doesn't exist. Give a recovery
    // recipe that still works weeks later: find the commit that deleted the
    // path, then check the file out of that commit's PARENT.
    out +=
      `\n> [!warning] Bulk deletion — ${deletions.length} vault files removed in one commit (${dateStr} ${timeStr})\n` +
      `> Verify this was intentional. Recover any path with:\n` +
      '> `git checkout "$(git log -1 --format=%H --diff-filter=D -- "<path>")^" -- "<path>"`\n';
    for (const p of deletions) out += `> - \`${p}\`\n`;
    out += '\n';

    process.stderr.write(
      `\n  braynee: ${deletions.length} vault files staged for DELETION in this commit.\n` +
        `  Logged to 2. Areas/Changelog/${dateStr}.md — verify it was intentional.\n\n`
    );
  }

  fs.appendFileSync(changelogPath, out, 'utf8');
}

try {
  main();
} catch {
  // Audit logging must never cost the user a commit.
}
process.exit(0);
