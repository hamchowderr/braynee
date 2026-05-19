#!/usr/bin/env node
// prd-audit.mjs — Audit every PRD under 2. Areas/Product Manager/PRDs/ against
// the braynee PRD schema. Reports per-PRD gaps so they can be fixed in batch.
//
// Schema requirements (all from frontmatter unless noted):
//   - type: prd
//   - name: non-empty string
//   - project: "[[1. Projects/<X>]]" — must resolve to a real file
//   - folder: <slug> — the project repo dir name inside the configured
//                       projects root (BRAYNEE_PROJECTS_DIR, default ~/code);
//                       warn-only if missing
//   - status: draft | active | shipped | archived
//   - build_status: not-started | planning | drafting | in-progress | blocked | shipped
//   - seeded: boolean (NEW — added by this schema; reported as missing)
//   - acceptance_criteria_count: count of `- [ ] **[Pn] ...**` lines in body
//
// Usage: node prd-audit.mjs [--json] [--vault <path>]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getProjectsDir, isProjectsDirConfigured } = require('./lib/projects-root.js');

const VAULT = process.argv.includes('--vault')
  ? process.argv[process.argv.indexOf('--vault') + 1]
  : path.join(os.homedir(), 'Obsidian Vault');
// Projects root: BRAYNEE_PROJECTS_DIR > BEADS_CODE_DIR > ~/code (back-compat).
const CODE_DIR = getProjectsDir();
const PRD_DIR = path.join(VAULT, '2. Areas', 'Product Manager', 'PRDs');
const PROJECTS_DIR = path.join(VAULT, '1. Projects');
const ARCHIVED_PROJECTS_DIR = path.join(VAULT, '4. Archives', 'Projects');
const JSON_MODE = process.argv.includes('--json');

const VALID_STATUS = new Set(['draft', 'active', 'shipped', 'archived']);
const VALID_BUILD = new Set(['not-started', 'planning', 'drafting', 'in-progress', 'blocked', 'shipped']);

function parseFrontmatter(content) {
  const normalized = content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let [, k, v] = kv;
    v = v.trim().replace(/^["'](.*)["']$/, '$1');
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (/^\d+$/.test(v)) v = parseInt(v);
    fm[k] = v;
  }
  return fm;
}

function walkMd(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(p));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function projectFileExists(projectField) {
  if (!projectField) return false;
  const m = String(projectField).match(/\[\[([^\]]+)\]\]/);
  if (!m) return false;
  const ref = m[1].replace(/^1\. Projects\//, '').trim();
  const candidates = [
    path.join(PROJECTS_DIR, `${ref}.md`),
    path.join(PROJECTS_DIR, ref, '_index.md'),
    path.join(ARCHIVED_PROJECTS_DIR, `${ref}.md`),
  ];
  return candidates.some(p => fs.existsSync(p));
}

function countAcceptanceCriteria(content) {
  // Strip BOM + frontmatter, normalize CRLF
  const body = content.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '');
  // Find the Acceptance Criteria section
  const m = body.match(/##\s+Acceptance Criteria\s*\n([\s\S]*?)(?=\n##\s+|\n*$)/i);
  if (!m) return null;
  const lines = m[1].split('\n');
  return lines.filter(l => /^\s*-\s+\[\s\]\s+\*\*\[P[0-3]\]/.test(l)).length;
}

function audit(file) {
  const content = fs.readFileSync(file, 'utf-8');
  const fm = parseFrontmatter(content);
  const issues = [];
  const warnings = [];

  if (!fm) {
    issues.push('NO FRONTMATTER');
    return { file, fm: null, issues, warnings };
  }

  if (fm.type !== 'prd') issues.push(`type should be "prd" (got "${fm.type ?? 'missing'}")`);
  if (!fm.name) issues.push('name missing');
  if (!fm.project) issues.push('project missing');
  else if (!projectFileExists(fm.project)) issues.push(`project backlink does not resolve: ${fm.project}`);
  if (!fm.folder) issues.push('folder missing');
  else if (!fs.existsSync(path.join(CODE_DIR, fm.folder))) {
    const hint = isProjectsDirConfigured()
      ? ''
      : ' (set BRAYNEE_PROJECTS_DIR if your repos are not under ~/code)';
    warnings.push(`folder "${fm.folder}" not found at ${path.join(CODE_DIR, fm.folder)} (PRD may predate the build)${hint}`);
  }
  if (!VALID_STATUS.has(fm.status)) issues.push(`status invalid (got "${fm.status ?? 'missing'}", expected one of ${[...VALID_STATUS].join('|')})`);
  if (fm.build_status && !VALID_BUILD.has(fm.build_status)) issues.push(`build_status invalid (got "${fm.build_status}")`);

  // NEW seedable fields — flag as missing
  if (typeof fm.seeded !== 'boolean') warnings.push('seeded field missing (NEW — needed for braynee:prd-seed)');
  if (!('seeded_at' in fm)) warnings.push('seeded_at field missing (NEW)');
  if (!('seeded_count' in fm)) warnings.push('seeded_count field missing (NEW)');

  const acCount = countAcceptanceCriteria(content);
  if (acCount === null) warnings.push('## Acceptance Criteria section not found');
  else if (acCount === 0) warnings.push('## Acceptance Criteria section has 0 seedable items');

  return { file, fm, issues, warnings, acceptanceCount: acCount };
}

const allMd = walkMd(PRD_DIR);
// Skip _index.md and reference companion docs (type != "prd").
// Files with no frontmatter still get audited so we can flag the stub.
const skipped = [];
const prdFiles = allMd.filter(f => {
  if (path.basename(f).startsWith('_')) return false;
  const content = fs.readFileSync(f, 'utf-8');
  const fm = parseFrontmatter(content);
  if (fm && fm.type && fm.type !== 'prd') {
    skipped.push({ file: f, type: fm.type });
    return false;
  }
  return true;
});

const results = prdFiles.map(audit);

if (JSON_MODE) {
  process.stdout.write(JSON.stringify(results, null, 2));
  process.exit(0);
}

const rel = f => path.relative(PRD_DIR, f);
const cleanCount = results.filter(r => r.issues.length === 0 && r.warnings.length === 0).length;
const warnCount = results.filter(r => r.issues.length === 0 && r.warnings.length > 0).length;
const errorCount = results.filter(r => r.issues.length > 0).length;

console.log(`# PRD Audit — ${PRD_DIR}\n`);
console.log(`Found ${prdFiles.length} PRD file(s) (skipped ${skipped.length} reference/companion doc(s)).`);
console.log(`  Clean:   ${cleanCount}`);
console.log(`  Warning: ${warnCount}`);
console.log(`  Error:   ${errorCount}\n`);

const errors = results.filter(r => r.issues.length > 0);
if (errors.length) {
  console.log(`## Errors (${errors.length})\n`);
  for (const r of errors) {
    console.log(`### ${rel(r.file)}`);
    for (const i of r.issues) console.log(`  ✗ ${i}`);
    for (const w of r.warnings) console.log(`  ⚠ ${w}`);
    if (r.acceptanceCount !== null && r.acceptanceCount !== undefined) {
      console.log(`  ◦ Acceptance criteria items: ${r.acceptanceCount}`);
    }
    console.log('');
  }
}

const warns = results.filter(r => r.issues.length === 0 && r.warnings.length > 0);
if (warns.length) {
  console.log(`## Warnings (${warns.length})\n`);
  for (const r of warns) {
    console.log(`### ${rel(r.file)}`);
    for (const w of r.warnings) console.log(`  ⚠ ${w}`);
    if (r.acceptanceCount !== null && r.acceptanceCount !== undefined) {
      console.log(`  ◦ Acceptance criteria items: ${r.acceptanceCount}`);
    }
    console.log('');
  }
}

const cleans = results.filter(r => r.issues.length === 0 && r.warnings.length === 0);
if (cleans.length) {
  console.log(`## Clean (${cleans.length})\n`);
  for (const r of cleans) {
    console.log(`  ✓ ${rel(r.file)} — ${r.acceptanceCount} acceptance criteria`);
  }
}
