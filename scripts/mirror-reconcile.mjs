#!/usr/bin/env node
/**
 * mirror-reconcile.mjs — create the missing beads→TaskNotes mirrors, fleet-wide
 * (cp-na6c).
 *
 * The per-call PostToolUse mirror is bypassed by any batched or piped `bd create`,
 * and the PostToolBatch reconcile that heals it only ever swept the CURRENT repo,
 * and only when it saw `bd create` in that batch. So a repo populated by a
 * scripted run and never opened interactively was never reconciled at all —
 * which is why four repos sat at exactly 0% mirrored.
 *
 * This sweeps every beads repo. It is the same operation the hook performs, so
 * running it is both the one-time backfill and the ongoing repair path; cp-na6c's
 * own design note warns that a backfill without fixing the leak just re-drifts,
 * which is why the two share this code rather than being separate tools.
 *
 * DRY-RUN BY DEFAULT. It creates notes in the user's vault, so it never writes
 * without --write.
 *
 * Usage:
 *   node scripts/mirror-reconcile.mjs [--write] [--root <dir>] [--repo <name>]...
 *                                     [--limit <n>] [--include-dead] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TN = require('../hooks/lib/tasknotes-mirror.js');
const { readIssues } = require('../hooks/lib/read-issues-jsonl.js');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const opt = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const multi = (n) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === n && argv[i + 1]) out.push(argv[i + 1]);
  return out;
};

const WRITE = has('--write');
const AS_JSON = has('--json');
const ROOT = path.resolve(opt('--root', path.join(os.homedir(), 'code')));
const ONLY = multi('--repo');
const LIMIT = Number(opt('--limit', '0')) || 0;
const INCLUDE_DEAD = has('--include-dead');

// Retired project families. Mirroring their issues creates vault notes for work
// nobody will do; measured 2026-07-26, they are also BETTER mirrored than live
// repos, so skipping them does not hide a problem.
const DEAD = /^sophon(-|$)|^comfyui-sophon$/;

function discover() {
  let entries;
  try {
    entries = fs.readdirSync(ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (ONLY.length && !ONLY.includes(e.name)) continue;
    if (!ONLY.length && !INCLUDE_DEAD && DEAD.test(e.name)) continue;
    const p = path.join(ROOT, e.name);
    if (fs.existsSync(path.join(p, '.beads'))) out.push(p);
  }
  return out.sort();
}

const repos = discover();
const rows = [];
let totalMissing = 0;
let totalCreated = 0;
let totalFailed = 0;

for (const repo of repos) {
  const name = path.basename(repo);
  let issues;
  try {
    issues = readIssues(repo);
  } catch {
    continue;
  }
  if (!issues || !issues.length) continue;

  const projectSlug = TN.projectSlugFrom(name);
  const missing = [];
  for (const it of issues) {
    if (!it || !it.id || !it.title) continue;
    // Only live work, matching the hook: closed issues are completed in
    // TaskNotes by the close-side sync, not created by the mirror.
    if (it.status === 'closed') continue;
    if (TN.findTasknoteForIssueId(it.id)) continue;
    missing.push(it);
  }
  if (!missing.length) continue;

  totalMissing += missing.length;
  let created = 0;
  let failed = 0;

  if (WRITE) {
    const batch = LIMIT ? missing.slice(0, LIMIT) : missing;
    for (const it of batch) {
      try {
        TN.ensureMtnTask(it.id, it.title, TN.normalizePriority(it.priority), projectSlug);
        // Verify rather than trust: ensureMtnTask shells out to `mtn create`,
        // which can fail silently, and reporting a create that did not happen is
        // exactly the false-confidence this issue is about.
        if (TN.findTasknoteForIssueId(it.id)) created++;
        else failed++;
      } catch {
        failed++;
      }
    }
  }

  totalCreated += created;
  totalFailed += failed;
  rows.push({ name, issues: issues.length, missing: missing.length, created, failed,
              sample: missing.slice(0, 3).map((i) => i.id) });
}

if (AS_JSON) {
  console.log(JSON.stringify({
    write: WRITE, root: ROOT,
    totals: { missing: totalMissing, created: totalCreated, failed: totalFailed },
    repos: rows,
  }, null, 2));
  process.exit(0);
}

console.log(`${WRITE ? 'WRITING' : 'DRY RUN (pass --write to apply)'}  root=${ROOT}`);
console.log(`repos needing mirrors: ${rows.length}\n`);
rows.sort((a, b) => b.missing - a.missing);
console.log('  missing  created  repo');
for (const r of rows) {
  console.log(`  ${String(r.missing).padStart(7)}  ${String(r.created).padStart(7)}  ${r.name}` +
              (r.failed ? `   (${r.failed} FAILED)` : ''));
}
console.log(`\ntotal missing: ${totalMissing}`);
if (WRITE) {
  console.log(`created: ${totalCreated}   failed: ${totalFailed}`);
  if (totalFailed) console.log('FAILED creates left the issue unmirrored — re-run to retry.');
} else {
  console.log('Nothing written. Re-run with --write to create these TaskNotes.');
}
