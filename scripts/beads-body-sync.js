#!/usr/bin/env node
// beads-body-sync.js — populate TaskNote bodies with beads description + close_reason.
//
// WHY: braynee mirrors every beads issue to a vault TaskNote (tasknotes-mirror.js),
// but `mtn create` only writes frontmatter — the note BODY is empty. So the
// high-value reasoning (an issue's description and, once closed, its close_reason
// = "how we solved it") lives only in each repo's hidden .beads/issues.jsonl,
// which QMD's file-walker refuses to index (it skips dot-directories). This script
// copies that reasoning into the note body, where it rides the already-indexed
// `vault` QMD collection. Result: beads decisions become searchable, no hidden-dir
// problem, no new collection.
//
// Design: read every repo's issues.jsonl (server-free, via read-issues-jsonl.js),
// build one id→issue map, then walk the TaskNotes ONCE and match each note's
// tags back to an issue id (O(notes)+O(issues), not O(notes×issues)). The body
// content lives inside a managed <!-- beads-detail --> block so re-runs update
// cleanly and any human-authored body text is preserved.
//
// Safe by default: DRY-RUN unless `--write` is passed.
//   node scripts/beads-body-sync.js            # dry-run: report + one sample
//   node scripts/beads-body-sync.js --write     # actually update note bodies
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { readIssues } = require(path.join(__dirname, '..', 'hooks', 'lib', 'read-issues-jsonl.js'));
const { TASKNOTES_DIR } = require(path.join(__dirname, '..', 'hooks', 'lib', 'tasknotes-mirror.js'));

const CODE_DIR = path.join(os.homedir(), 'code');
const WRITE = process.argv.includes('--write');
const START = '<!-- beads-detail:start -->';
const END = '<!-- beads-detail:end -->';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── 1. one id→issue map from every repo's .beads/issues.jsonl ──────────────────
function buildIssueMap() {
  const map = new Map();
  let repos = 0, issues = 0;
  let entries = [];
  try { entries = fs.readdirSync(CODE_DIR, { withFileTypes: true }); } catch { return { map, repos, issues }; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const root = path.join(CODE_DIR, e.name);
    if (!fs.existsSync(path.join(root, '.beads', 'issues.jsonl'))) continue;
    const recs = readIssues(root);
    if (!recs.length) continue;
    repos++;
    for (const iss of recs) {
      if (!iss.id) continue;
      issues++;
      // first-writer wins; ids are workspace-prefixed so collisions are rare
      if (!map.has(iss.id)) map.set(iss.id, iss);
    }
  }
  return { map, repos, issues };
}

// ── 2. extract the beads id from a note's frontmatter tags ─────────────────────
function tagsFromFrontmatter(fm) {
  const tags = [];
  const flow = fm.match(/^tags:\s*\[([^\]]*)\]/m);
  if (flow) for (const t of flow[1].split(',')) { const s = t.trim().replace(/^['"]|['"]$/g, ''); if (s) tags.push(s); }
  const block = fm.match(/^tags:\s*\n((?:[ \t]*-[ \t]*.+\n?)+)/m);
  if (block) for (const l of block[1].split('\n')) { const m = l.match(/-[ \t]*(.+)/); if (m) { const s = m[1].trim().replace(/^['"]|['"]$/g, ''); if (s) tags.push(s); } }
  return tags;
}

function issueIdFromTags(tags, map) {
  for (const t of tags) {
    if (map.has(t)) return t;
    // Brainy<->Braynee rename: tag/id diverged across the rename
    if (t.startsWith('braynee') && map.has(t.replace(/^braynee/, 'brainy'))) return t.replace(/^braynee/, 'brainy');
    if (t.startsWith('brainy') && map.has(t.replace(/^brainy/, 'braynee'))) return t.replace(/^brainy/, 'braynee');
  }
  return null;
}

// ── 3. build + splice the managed body block ───────────────────────────────────
function buildBlock(iss) {
  const lines = [START];
  const desc = (iss.description || '').trim();
  const resolved = (iss.close_reason || '').trim();
  if (desc) lines.push(`**Description:** ${desc}`);
  if (resolved) lines.push(`**Resolved:** ${resolved}`);
  if (lines.length === 1) return null; // nothing to write
  lines.push(END);
  return lines.join('\n\n');
}

// Returns the rebuilt file content, or null if it can't (no frontmatter).
function spliceBlock(content, block) {
  const m = content.match(/^(﻿?---\r?\n[\s\S]*?\r?\n---)\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = m[1];
  let body = m[2];
  body = body.replace(new RegExp(esc(START) + '[\\s\\S]*?' + esc(END)), ''); // strip prior block
  body = body.replace(/^\s+/, '').replace(/\s+$/, '');                       // trim
  return fm + '\n\n' + block + (body ? '\n\n' + body : '') + '\n';
}

// ── main ───────────────────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync(TASKNOTES_DIR)) { console.error(`TaskNotes dir not found: ${TASKNOTES_DIR}`); process.exit(1); }
  const { map, repos, issues } = buildIssueMap();
  console.log(`Scanned ${repos} repos → ${issues} issues (${map.size} unique ids).`);

  const notes = fs.readdirSync(TASKNOTES_DIR).filter(n => n.endsWith('.md'));
  const stat = { notes: notes.length, matched: 0, hasContent: 0, wouldWrite: 0, unchanged: 0, noFm: 0, noIssue: 0 };
  let sample = null;

  for (const name of notes) {
    const file = path.join(TASKNOTES_DIR, name);
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const fmMatch = content.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) { stat.noFm++; continue; }
    const id = issueIdFromTags(tagsFromFrontmatter(fmMatch[1]), map);
    if (!id) { stat.noIssue++; continue; }
    stat.matched++;
    const block = buildBlock(map.get(id));
    if (!block) continue; // issue has no description/close_reason
    stat.hasContent++;
    const updated = spliceBlock(content, block);
    if (updated == null || updated === content) { stat.unchanged++; continue; }
    stat.wouldWrite++;
    if (!sample) sample = { name, id, before: content, after: updated };
    if (WRITE) { try { fs.writeFileSync(file, updated); } catch (e) { console.error(`  write failed: ${name}: ${e.message}`); } }
  }

  console.log(`\nTaskNotes: ${stat.notes} total`);
  console.log(`  matched to an issue:      ${stat.matched}`);
  console.log(`  issue has description/reason: ${stat.hasContent}`);
  console.log(`  ${WRITE ? 'WROTE' : 'would write'}:              ${stat.wouldWrite}`);
  console.log(`  already up-to-date:       ${stat.unchanged}`);
  console.log(`  no beads id in tags:      ${stat.noIssue}`);
  console.log(`  no frontmatter:           ${stat.noFm}`);

  if (sample && !WRITE) {
    console.log(`\n─── SAMPLE (dry-run) — ${sample.name}  [${sample.id}] ───`);
    console.log('BEFORE:\n' + sample.before.slice(0, 400));
    console.log('\nAFTER:\n' + sample.after.slice(0, 900));
  }
  if (!WRITE) console.log(`\n(dry-run — no files changed. Re-run with --write to apply.)`);
}

main();
