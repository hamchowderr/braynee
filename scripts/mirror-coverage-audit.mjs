#!/usr/bin/env node
/**
 * mirror-coverage-audit.mjs — how much of beads is actually mirrored into the
 * vault's TaskNotes? (cp-na6c)
 *
 * The three-way mirror (bd -> TodoWrite -> TaskNotes) is documented as
 * one-to-one. A 2026-07-25 audit measured it at 46%. cp-na6c's acceptance asks
 * for coverage to be "checkable on demand so the next drift is caught early" —
 * that is this script, rather than a one-off measurement pasted into an issue.
 *
 * Join key: a TaskNote carries its beads id as a frontmatter TAG
 * (`tags:\n  - skate-t9k`), so the id is matched against the tag list, not
 * against free text. Matching anywhere in the body would count a note that
 * merely mentions an id as mirrored, inflating coverage.
 *
 * Read-only. Never writes to the vault or to beads.
 *
 * Usage:
 *   node scripts/mirror-coverage-audit.mjs [--root <dir>] [--json]
 *                                          [--repo <name>]... [--min <pct>]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getVaultRoot } = require('./lib/vault-root.js');

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const multi = (n) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === n && argv[i + 1]) out.push(argv[i + 1]);
  return out;
};
const AS_JSON = argv.includes('--json');
const ROOT = path.resolve(opt('--root', path.join(os.homedir(), 'code')));
const ONLY = multi('--repo');
const MIN = Number(opt('--min', '0'));

const VAULT = getVaultRoot();
const TASKS_DIR = path.join(VAULT, '2. Areas', 'TaskNotes', 'Tasks');

/* ------------------------------------------------- vault tag index (once) -- */

/**
 * Every beads id that appears as a TAG in any TaskNote.
 * Built once and reused: 2,000+ notes x 2,000+ ids would otherwise be millions
 * of substring scans.
 */
function buildTagIndex(dir) {
  const tags = new Set();
  let notes = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.md')) continue;
      notes++;
      let text;
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      const fm = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
      if (!fm) continue;
      // Only the tags: block. A `- foo` under projects: or any other key is not
      // a beads id and must not count as a mirrored issue.
      const block = fm[1].match(/^tags:\s*\n((?:\s*-\s*.+\n?)+)/m);
      if (!block) continue;
      for (const line of block[1].split('\n')) {
        const m = line.match(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/);
        if (m) tags.add(m[1].toLowerCase());
      }
    }
  };
  walk(dir);
  return { tags, notes };
}

/* ----------------------------------------------------------- beads side -- */

function issuesFor(repo) {
  const r = spawnSync(
    'bd',
    ['list', '--status', 'open', '--status', 'in_progress', '--status', 'closed', '--json'],
    { cwd: repo, encoding: 'utf8', timeout: 60000, windowsHide: true },
  );
  // Parse stdout ALONE first. bd writes warnings to stderr ("no beads
  // configuration found in ...; using default database name"), and concatenating
  // the two puts that text AFTER the JSON, so parsing from the first `[` throws
  // on the trailing content. That misreported 85 genuinely EMPTY repos as
  // unreadable — an error count five times the real one, which is exactly the
  // kind of invented problem this audit exists to avoid.
  const stdout = r.stdout || '';
  const combined = stdout + (r.stderr || '');
  let parsed = null;
  for (const text of [stdout, combined]) {
    for (const s of [text.indexOf('['), text.indexOf('{"')]) {
      if (s < 0) continue;
      try {
        const j = JSON.parse(text.slice(s));
        parsed = Array.isArray(j) ? j : j.issues || null;
        if (parsed) break;
      } catch {
        /* try the next candidate offset / text */
      }
    }
    if (parsed) break;
  }
  const out = combined;
  if (!parsed) {
    // spawnSync reports a timeout as status===null + SIGTERM, which is
    // indistinguishable from a crash unless the signal is checked.
    const timedOut = r.status === null && (r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT');
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let err = null;
    for (const l of lines) {
      if (/error|failed|cannot|unable|no beads|refus/i.test(l)) { err = l; break; }
    }
    return { issues: null, err: timedOut ? 'TIMEOUT' : (err || lines[lines.length - 1] || 'no output') };
  }
  return { issues: parsed, err: null };
}

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
    const p = path.join(ROOT, e.name);
    if (fs.existsSync(path.join(p, '.beads'))) out.push(p);
  }
  return out;
}

/* ----------------------------------------------------------------- main -- */

if (!fs.existsSync(TASKS_DIR)) {
  console.error(`TaskNotes dir not found: ${TASKS_DIR}`);
  process.exit(1);
}

const { tags, notes } = buildTagIndex(TASKS_DIR);
const repos = discover();

const rows = [];
let totalIssues = 0;
let totalMirrored = 0;
const errored = [];

for (const repo of repos) {
  const name = path.basename(repo);
  const { issues, err } = issuesFor(repo);
  if (!issues) { errored.push({ name, err }); continue; }
  if (!issues.length) continue;              // an empty repo is not 0% coverage
  let mirrored = 0;
  const missing = [];
  for (const i of issues) {
    if (!i || !i.id) continue;
    if (tags.has(String(i.id).toLowerCase())) mirrored++;
    else missing.push(i.id);
  }
  totalIssues += issues.length;
  totalMirrored += mirrored;
  rows.push({
    name,
    issues: issues.length,
    mirrored,
    missing: missing.length,
    pct: Math.round((mirrored / issues.length) * 100),
    missingIds: missing.slice(0, 10),
  });
}

const overall = totalIssues ? Math.round((totalMirrored / totalIssues) * 100) : 0;

if (AS_JSON) {
  console.log(JSON.stringify({
    vault: VAULT, root: ROOT, taskNotes: notes, distinctTags: tags.size,
    totals: { issues: totalIssues, mirrored: totalMirrored, pct: overall },
    repos: rows, errored,
  }, null, 2));
  process.exit(0);
}

console.log(`TaskNotes scanned: ${notes}  (distinct tags: ${tags.size})`);
console.log(`beads repos with issues: ${rows.length}   unreadable: ${errored.length}`);
console.log(`\nOVERALL: ${totalMirrored}/${totalIssues} mirrored = ${overall}%\n`);

rows.sort((a, b) => a.pct - b.pct || b.issues - a.issues);
console.log('  pct  mirrored/total  repo');
for (const r of rows) {
  if (r.pct < MIN) continue;
  const flag = r.pct === 100 ? '' : r.pct === 0 ? '   <-- ZERO' : '';
  console.log(`  ${String(r.pct).padStart(3)}%  ${String(r.mirrored + '/' + r.issues).padStart(9)}      ${r.name}${flag}`);
}
if (errored.length) {
  console.log(`\nunreadable (excluded from the percentages):`);
  for (const e of errored) console.log(`  ${e.name.padEnd(28)} ${String(e.err).slice(0, 70)}`);
}
