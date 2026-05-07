#!/usr/bin/env node
// prd-seed.mjs — Convert a PRD's Acceptance Criteria into bd issues.
// Usage: node prd-seed.mjs "<Name>" [--dry-run]
//
// Resolves the PRD by exact name, slug, or path. Locates the matching code
// project via the `folder:` frontmatter field. Parses the Acceptance Criteria
// section (see SKILL.md for the format) and runs `bd create` for each line.
// On success, flips `seeded: true` and writes `seeded_at` + `seeded_count`.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const VAULT = path.join(os.homedir(), 'Obsidian Vault');
const PRD_DIR = path.join(VAULT, '2. Areas', 'Product Manager', 'PRDs');
const CODE_DIR = path.join(os.homedir(), 'code');

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

const prdPath = resolvePrd(target);
if (!prdPath) { console.error(`PRD not found: ${target}`); process.exit(1); }

const content = fs.readFileSync(prdPath, 'utf-8');
const { fm, body } = parseFrontmatter(content);
if (!fm) { console.error(`No frontmatter in ${prdPath}`); process.exit(1); }
if (fm.seeded === true && !dryRun) {
  console.error(`PRD already seeded (seeded: true, seeded_count: ${fm.seeded_count}). Aborting to avoid duplicates.`);
  console.error('To re-seed, manually flip seeded: false in the PRD frontmatter.');
  process.exit(1);
}
if (!fm.folder) { console.error(`PRD has no folder field — cannot determine target repo`); process.exit(1); }

const repoDir = path.join(CODE_DIR, fm.folder);
if (!fs.existsSync(path.join(repoDir, '.beads'))) {
  console.error(`Target repo has no .beads dir: ${repoDir}`);
  console.error(`Run \`bd init --shared-server -p "${fm.folder}"\` there first, or open a session in that folder so brainy auto-inits beads.`);
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

let createdCount = 0;
for (const item of items) {
  const labels = [];
  if (item.milestone) labels.push(`milestone:${item.milestone.replace(/\s+/g, '_')}`);
  labels.push(`prd:${path.basename(prdPath, '.md')}`);
  const labelArgs = labels.map(l => `-l ${JSON.stringify(l)}`).join(' ');
  const descFlag = item.description ? `-d ${JSON.stringify(item.description)}` : '';
  const cmd = `bd create ${JSON.stringify(item.title)} -p ${PRIORITY_FLAG[item.priority]} ${descFlag} ${labelArgs}`.trim();

  if (dryRun) {
    console.log(`[dry-run] ${cmd}`);
    createdCount++;
    continue;
  }

  try {
    const out = execSync(cmd, { cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    console.log(`✓ ${item.priority} ${item.title}`);
    if (out) console.log(`    ${out.split('\n')[0]}`);
    createdCount++;
  } catch (err) {
    console.log(`✗ ${item.priority} ${item.title}`);
    console.log(`    ${(err.stderr?.toString() || err.message).split('\n')[0]}`);
  }
}

if (!dryRun && createdCount > 0) {
  const updated = updateFrontmatter(content, {
    seeded: true,
    seeded_at: new Date().toISOString(),
    seeded_count: createdCount,
    updated: new Date().toISOString().slice(0, 10),
  });
  fs.writeFileSync(prdPath, updated, 'utf-8');
  console.log(`\nUpdated PRD: seeded: true, seeded_count: ${createdCount}`);
}

console.log(`\nDone. ${createdCount}/${items.length} issues ${dryRun ? 'would be created' : 'created'}.`);
