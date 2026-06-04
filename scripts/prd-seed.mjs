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
const { getVaultRoot } = require('./lib/vault-root.js');
// cp-8ru: prd-seed creates issues via internal execSync, so the PostToolUse
// beads-status-sync hook never sees them and seeded backlogs got zero
// TaskNotes. Mirror them here using the SAME shared implementation.
const TN = require('../hooks/lib/tasknotes-mirror.js');
// cp-9f2.3/.4: pure parse + DoD + dependency-edge logic (unit-tested in
// scripts/lib/prd-seed-core.test.js via bin/braynee-self-test §7).
const CORE = require('./lib/prd-seed-core.js');

const VAULT = getVaultRoot();
const PRD_DIR = path.join(VAULT, '2. Areas', 'Product Manager', 'PRDs');
// Projects root: BRAYNEE_PROJECTS_DIR > BEADS_CODE_DIR > ~/code (back-compat).
const CODE_DIR = getProjectsDir();

const args = process.argv.slice(2);
if (!args[0]) {
  console.error('Usage: prd-seed.mjs "<Name>" [--dry-run]');
  process.exit(1);
}
const target = args[0];
const dryRun = args.includes('--dry-run');
const noDod = args.includes('--no-dod');

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

// parseAcceptanceCriteria moved to ./lib/prd-seed-core.js (CORE) — it now also
// parses per-line `{after: ...}` gating annotations (cp-9f2.3).

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
function persistedIssues(prdLabel, repoDir) {
  let out;
  try {
    out = execSync(
      `bd list -l ${JSON.stringify(prdLabel)} --all -n 0 --json`,
      { cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
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
  // titles: reconcile handle (create only missing). byTitle: title→id, used to
  // resolve dependency edges into `bd dep add` after issues persist (cp-9f2.3).
  const titles = new Set();
  const byTitle = new Map();
  for (const issue of Array.isArray(parsed) ? parsed : []) {
    if (issue && typeof issue.title === 'string') {
      const t = issue.title.trim();
      titles.add(t);
      if (issue.id && !byTitle.has(t)) byTitle.set(t, issue.id);
    }
  }
  return { titles, byTitle };
}

// cp-9f2.3: add dependency edges via `bd dep add <issue> <depends-on>` once both
// endpoints persist. Idempotent — an edge that already exists is counted as
// skipped, not failed; an endpoint not yet persisted (partial seed) is deferred
// to the next re-run.
function addDependencyEdges(edges, byTitle, repoDir) {
  // `bd dep add` is idempotent (verified: a duplicate add succeeds and does not
  // create a second edge), so we report ensure-semantics, not "newly added".
  let ensured = 0, deferred = 0, failed = 0;
  for (const e of edges) {
    const fromId = byTitle.get(e.fromTitle.trim());
    const toId = byTitle.get(e.toTitle.trim());
    if (!fromId || !toId) { deferred++; continue; }   // endpoint not persisted yet (partial seed)
    try {
      execSync(`bd dep add ${fromId} ${toId}`, {
        cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      ensured++;
    } catch (err) {
      const msg = (err.stderr?.toString() || err.message || '').toLowerCase();
      if (/already|exist|duplicate/.test(msg)) { ensured++; }   // present (some bd builds error on dup)
      else { failed++; console.log(`    ✗ dep ${fromId} -> ${toId}: ${(err.stderr?.toString() || err.message).split('\n')[0]}`); }   // e.g. a cycle
    }
  }
  return { ensured, deferred, failed };
}

// cp-8ru: mirror every persisted PRD issue to TaskNotes via the shared
// tasknotes-mirror lib (same impl the PostToolUse hook uses, so a seeded
// backlog now lands in TaskNotes just like hand-typed `bd create`s).
// Best-effort: never fail the seed over a mirror hiccup. Idempotent —
// ensureMtnTask dedupes by #<issueId>, so re-runs create no duplicates.
function mirrorSeededToTasknotes(prdLabel, repoDir) {
  let parsed;
  try {
    const out = execSync(
      `bd list -l ${JSON.stringify(prdLabel)} --all -n 0 --json`,
      { cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    parsed = JSON.parse(out.trim() || '[]');
  } catch {
    console.error(`(TaskNotes mirror skipped: could not re-query target beads.)`);
    return { mirrored: 0, total: 0 };
  }
  const issues = (Array.isArray(parsed) ? parsed : []).filter(i => i && i.id && typeof i.title === 'string');
  const projectSlug = TN.projectSlugFrom(path.basename(repoDir));
  let mirrored = 0;
  for (const issue of issues) {
    try {
      const existed = TN.findTasknoteForIssueId(issue.id);
      TN.ensureMtnTask(issue.id, issue.title, TN.normalizePriority(issue.priority), projectSlug);
      if (!existed) mirrored++;
    } catch { /* best-effort per issue */ }
  }
  return { mirrored, total: issues.length };
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
    console.error(`If your repos are not under ~/code, set BRAYNEE_PROJECTS_DIR to your projects root (e.g. export BRAYNEE_PROJECTS_DIR=/path/to/repos).`);
  } else {
    console.error(`(projects root resolved from BRAYNEE_PROJECTS_DIR/BEADS_CODE_DIR: ${CODE_DIR})`);
  }
  process.exit(1);
}
if (!fs.existsSync(path.join(repoDir, '.beads'))) {
  console.error(`Target repo has no .beads dir: ${repoDir}`);
  console.error(`Run \`bd init --shared-server --external -p "${fm.folder}"\` there first, or open a session in that folder so braynee auto-inits beads.`);
  process.exit(1);
}

const items = CORE.parseAcceptanceCriteria(body);
if (items.length === 0) {
  console.error(`No seedable items found in ## Acceptance Criteria section.`);
  console.error(`Expected lines like: - [ ] **[P0] Title** — description`);
  process.exit(1);
}

// cp-9f2.4: append the standard Quality & Deploy (DoD) milestone so the
// definition-of-done becomes beads on every project, sourced from the global
// ship-pipeline rule. Skipped via --no-dod, `dod: false` in PRD frontmatter, if
// the rule file is absent, or if the PRD already authored that milestone.
const shipPipelinePath = path.join(os.homedir(), '.claude', 'rules', 'ship-pipeline.md');
if (noDod || fm.dod === false) {
  console.log('DoD milestone: skipped (--no-dod or `dod: false`).');
} else {
  const dodItems = CORE.buildDodItems({ shipPipelinePath });
  if (dodItems.length === 0) {
    console.log(`DoD milestone: skipped — ship-pipeline rule not found at ${shipPipelinePath}.`);
  } else if (items.some(i => i.milestone === CORE.DOD_MILESTONE)) {
    console.log(`DoD milestone: PRD already defines "${CORE.DOD_MILESTONE}" — not injecting.`);
  } else {
    items.push(...dodItems);
    console.log(`DoD milestone: +${dodItems.length} standard "${CORE.DOD_MILESTONE}" issues injected.`);
  }
}

// cp-9f2.3: derive dependency edges (per-line `{after:}` annotations + gated
// milestones) so `bd ready` enforces order: scaffold → build → test → deploy.
const depEdges = CORE.computeDependencyEdges(items);

console.log(`PRD: ${prdPath}`);
console.log(`Target repo: ${repoDir}`);
console.log(`${items.length} acceptance criteria found` +
  `${depEdges.length ? `, ${depEdges.length} dependency edge(s) planned` : ''}.\n`);

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
  if (depEdges.length) {
    console.log(`\n[dry-run] Planned dependencies (bd dep add <issue> <depends-on>):`);
    for (const e of depEdges) console.log(`[dry-run]   "${e.fromTitle}" depends-on "${e.toTitle}"  (${e.reason})`);
  }
  console.log(`\nDone. ${items.length}/${items.length} issues would be created` +
    `${depEdges.length ? `, ${depEdges.length} dep edge(s) would be added` : ''}.`);
  process.exit(0);
}

// --- Reconcile: only create acceptance criteria not already persisted ---
const before = persistedIssues(prdLabel, repoDir);
if (before === null) {
  console.error(`\nAborting: could not verify existing seeded issues in target repo.`);
  process.exit(1);
}

const missing = items.filter(it => !before.titles.has(it.title.trim()));
const alreadyPresent = items.length - missing.length;
if (alreadyPresent > 0) {
  console.log(`${alreadyPresent}/${items.length} acceptance criteria already present in target — reconciling, creating only the ${missing.length} missing.\n`);
}

for (const item of missing) {
  const cmd = buildCreateCmd(item);
  try {
    const out = execSync(cmd, { cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).trim();
    console.log(`✓ ${item.priority} ${item.title}`);
    if (out) console.log(`    ${out.split('\n')[0]}`);
  } catch (err) {
    console.log(`✗ ${item.priority} ${item.title}`);
    console.log(`    ${(err.stderr?.toString() || err.message).split('\n')[0]}`);
  }
}

// --- Verify persistence: re-query the target repo, never trust exit codes ---
const after = persistedIssues(prdLabel, repoDir);
if (after === null) {
  console.error(`\nAborting: created issues but could not re-verify persistence in target repo. Leaving PRD seeded: false so it stays re-runnable.`);
  process.exit(1);
}
const verifiedCount = items.filter(it => after.titles.has(it.title.trim())).length;

// cp-9f2.3: issues now persisted with ids — add the planned dependency edges.
if (depEdges.length) {
  const dep = addDependencyEdges(depEdges, after.byTitle, repoDir);
  console.log(`Dependencies: ${dep.ensured} ensured, ${dep.deferred} deferred (endpoint pending), ${dep.failed} failed.`);
}

// cp-8ru: mirror persisted issues to TaskNotes (full or partial seed alike).
const tn = mirrorSeededToTasknotes(prdLabel, repoDir);
console.log(`TaskNotes: ${tn.mirrored} new mirrored, ${tn.total} total tracked.`);

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
