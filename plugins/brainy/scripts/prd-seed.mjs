#!/usr/bin/env node
// prd-seed.mjs — Convert a PRD's Acceptance Criteria into bd issues.
// Usage: node prd-seed.mjs "<Name>" [--dry-run]
//
// Resolves the PRD by exact name, slug, or path. Locates the matching code
// project via the `folder:` frontmatter field. Parses the Acceptance Criteria
// section (see SKILL.md for the format).
//
// Seeding is idempotent and self-verifying:
//   - Reconciles against the target repo's actual beads (label prd:<name>):
//     creates only acceptance criteria not already persisted (match by title).
//   - Verifies persistence by re-querying the target repo — never trusts
//     `bd create` exit codes.
//   - Flips `seeded: true` (+ seeded_at/seeded_count/updated) ONLY when the
//     verified persisted count === number of acceptance criteria. A partial
//     seed leaves `seeded: false` and exits non-zero, so a re-run safely
//     fills only the gap with no duplicates. A fully-seeded re-run is a no-op.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getProjectsDir, isProjectsDirConfigured } = require('./lib/projects-root.js');

const VAULT = path.join(os.homedir(), 'Obsidian Vault');
const PRD_DIR = path.join(VAULT, '2. Areas', 'Product Manager', 'PRDs');
// Projects root: BRAINY_PROJECTS_DIR > BEADS_CODE_DIR > ~/code (back-compat).
const CODE_DIR = getProjectsDir();

const args = process.argv.slice(2);
if (!args[0]) {
  console.error('Usage: prd-seed.mjs "<Name>" [--dry-run]');
  process.exit(1);
}
const target = args[0];
const dryRun = args.includes('--dry-run');

const PRIORITY_FLAG = { P0: '0', P1: '1', P2: '2', P3: '3' };

function stripBom(s) { return s.replace(/^﻿/, ''); }

function resolvePrd(target) {
  if (fs.existsSync(target)) return path.resolve(target);
  const tries = [
    path.join(PRD_DIR, `${target}.md`),
    path.join(PRD_DIR, `${target.replace(/\s+/g, '-')}.md`),
    path.join(PRD_DIR, target),
  ];
  for (const p of tries) if (fs.existsSync(p)) return p;
  // Loose match: scan and find a file whose stem matches case-insensitively
  for (const f of fs.readdirSync(PRD_DIR)) {
    if (f.toLowerCase() === `${target.toLowerCase()}.md`) return path.join(PRD_DIR, f);
  }
  return null;
}

function parseFrontmatter(content) {
  const normalized = stripBom(content).replace(/\r\n/g, '\n');
  const m = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { fm: null, fmRaw: '', body: normalized };
  const fmRaw = m[1];
  const fm = {};
  for (const line of fmRaw.split('\n')) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let [, k, v] = kv;
    v = v.trim().replace(/^["'](.*)["']$/, '$1');
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (/^\d+$/.test(v)) v = parseInt(v);
    fm[k] = v;
  }
  return { fm, fmRaw, body: normalized.slice(m[0].length) };
}

function parseAcceptanceCriteria(body) {
  const m = body.match(/##\s+Acceptance Criteria\s*\n([\s\S]*?)(?=\n##\s+|\n*$)/i);
  if (!m) return [];
  const lines = m[1].split('\n');
  const items = [];
  let currentMilestone = null;
  for (const line of lines) {
    const milestoneMatch = line.match(/^###\s+Milestone:\s+(.+?)\s*$/);
    if (milestoneMatch) { currentMilestone = milestoneMatch[1].trim(); continue; }
    const itemMatch = line.match(/^\s*-\s+\[\s\]\s+\*\*\[(P[0-3])\]\s+(.+?)\*\*\s*(?:[—-]\s*(.+))?$/);
    if (itemMatch) {
      items.push({
        priority: itemMatch[1],
        title: itemMatch[2].trim(),
        description: (itemMatch[3] || '').trim(),
        milestone: currentMilestone,
      });
    }
  }
  return items;
}

function updateFrontmatter(content, updates) {
  const normalized = stripBom(content).replace(/\r\n/g, '\n');
  const m = normalized.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!m) return content;
  let fmBody = m[2];
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${k}\\s*:.*$`, 'm');
    const formatted = typeof v === 'string' && v !== '' ? `${k}: "${v}"` : `${k}: ${v}`;
    if (re.test(fmBody)) fmBody = fmBody.replace(re, formatted);
    else fmBody = `${fmBody}\n${formatted}`;
  }
  return m[1] + fmBody + m[3] + normalized.slice(m[0].length);
}

// Query the TARGET repo's beads for issues actually persisted under the PRD
// label. This is the verification handle — we never trust `bd create` exit
// codes for persistence (a create can exit 0 without durably landing in a
// fresh project's shared-server/namespace state). Returns a Set of titles.
function persistedTitles(prdLabel, repoDir) {
  let out;
  try {
    out = execSync(
      `bd list -l ${JSON.stringify(prdLabel)} --all -n 0 --json`,
      { cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (err) {
    console.error(`Failed to query target repo beads for label ${prdLabel}: ${(err.stderr?.toString() || err.message).split('\n')[0]}`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(out.trim() || '[]');
  } catch {
    console.error(`Could not parse \`bd list --json\` output from target repo.`);
    return null;
  }
  const titles = new Set();
  for (const issue of Array.isArray(parsed) ? parsed : []) {
    if (issue && typeof issue.title === 'string') titles.add(issue.title.trim());
  }
  return titles;
}

const prdPath = resolvePrd(target);
if (!prdPath) { console.error(`PRD not found: ${target}`); process.exit(1); }

const content = fs.readFileSync(prdPath, 'utf-8');
const { fm, body } = parseFrontmatter(content);
if (!fm) { console.error(`No frontmatter in ${prdPath}`); process.exit(1); }
// Note: no hard-abort on `seeded: true`. Seeding is idempotent and reconciles
// against the target repo's actual beads state below — a fully-seeded PRD
// re-run is a clean no-op; a partial one creates only the missing gap.
if (!fm.folder) { console.error(`PRD has no folder field — cannot determine target repo`); process.exit(1); }

const repoDir = path.join(CODE_DIR, fm.folder);
if (!fs.existsSync(repoDir)) {
  console.error(`Target repo not found: ${repoDir}`);
  if (!isProjectsDirConfigured()) {
    console.error(`If your repos are not under ~/code, set BRAINY_PROJECTS_DIR to your projects root (e.g. export BRAINY_PROJECTS_DIR=/path/to/repos).`);
  } else {
    console.error(`(projects root resolved from BRAINY_PROJECTS_DIR/BEADS_CODE_DIR: ${CODE_DIR})`);
  }
  process.exit(1);
}
if (!fs.existsSync(path.join(repoDir, '.beads'))) {
  console.error(`Target repo has no .beads dir: ${repoDir}`);
  console.error(`Run \`bd init --shared-server --external -p "${fm.folder}"\` there first, or open a session in that folder so brainy auto-inits beads.`);
  process.exit(1);
}

const items = parseAcceptanceCriteria(body);
if (items.length === 0) {
  console.error(`No seedable items found in ## Acceptance Criteria section.`);
  console.error(`Expected lines like: - [ ] **[P0] Title** — description`);
  process.exit(1);
}

console.log(`PRD: ${prdPath}`);
console.log(`Target repo: ${repoDir}`);
console.log(`${items.length} acceptance criteria found.\n`);

const prdLabel = `prd:${path.basename(prdPath, '.md')}`;

function buildCreateCmd(item) {
  const labels = [];
  if (item.milestone) labels.push(`milestone:${item.milestone.replace(/\s+/g, '_')}`);
  labels.push(prdLabel);
  const labelArgs = labels.map(l => `-l ${JSON.stringify(l)}`).join(' ');
  const descFlag = item.description ? `-d ${JSON.stringify(item.description)}` : '';
  return `bd create ${JSON.stringify(item.title)} -p ${PRIORITY_FLAG[item.priority]} ${descFlag} ${labelArgs}`.trim();
}

if (dryRun) {
  for (const item of items) console.log(`[dry-run] ${buildCreateCmd(item)}`);
  console.log(`\nDone. ${items.length}/${items.length} issues would be created.`);
  process.exit(0);
}

// --- Reconcile: only create acceptance criteria not already persisted ---
const before = persistedTitles(prdLabel, repoDir);
if (before === null) {
  console.error(`\nAborting: could not verify existing seeded issues in target repo.`);
  process.exit(1);
}

const missing = items.filter(it => !before.has(it.title.trim()));
const alreadyPresent = items.length - missing.length;
if (alreadyPresent > 0) {
  console.log(`${alreadyPresent}/${items.length} acceptance criteria already present in target — reconciling, creating only the ${missing.length} missing.\n`);
}

for (const item of missing) {
  const cmd = buildCreateCmd(item);
  try {
    const out = execSync(cmd, { cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    console.log(`✓ ${item.priority} ${item.title}`);
    if (out) console.log(`    ${out.split('\n')[0]}`);
  } catch (err) {
    console.log(`✗ ${item.priority} ${item.title}`);
    console.log(`    ${(err.stderr?.toString() || err.message).split('\n')[0]}`);
  }
}

// --- Verify persistence: re-query the target repo, never trust exit codes ---
const after = persistedTitles(prdLabel, repoDir);
if (after === null) {
  console.error(`\nAborting: created issues but could not re-verify persistence in target repo. Leaving PRD seeded: false so it stays re-runnable.`);
  process.exit(1);
}
const verifiedCount = items.filter(it => after.has(it.title.trim())).length;

if (verifiedCount === items.length) {
  const updated = updateFrontmatter(content, {
    seeded: true,
    seeded_at: new Date().toISOString(),
    seeded_count: verifiedCount,
    updated: new Date().toISOString().slice(0, 10),
  });
  fs.writeFileSync(prdPath, updated, 'utf-8');
  console.log(`\nUpdated PRD: seeded: true, seeded_count: ${verifiedCount} (verified persisted in ${repoDir}).`);
  console.log(`\nDone. ${verifiedCount}/${items.length} issues verified persisted.`);
  process.exit(0);
}

console.error(`\n⚠ Partial seed: only ${verifiedCount}/${items.length} acceptance criteria verified persisted in the target repo.`);
console.error(`  PRD left seeded: false so this command can be re-run safely — it will create only the ${items.length - verifiedCount} still-missing issue(s), no duplicates.`);
process.exit(1);
