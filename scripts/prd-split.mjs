#!/usr/bin/env node
// prd-split.mjs — convert a monolithic PRD into the folder form (cp-s4uw).
//
//   PRDs/<Name>.md   ->   PRDs/<Name>/<Name>.md   (hub, keeps frontmatter)
//                         PRDs/<Name>/<Section>.md  (one per split section)
//
// Mirrors the layout PRDs get split into by hand once they outgrow one file: a
// hub named after its folder plus sibling chapters, linked from the hub with
// full-path wikilinks.
//
// Content-preserving by construction: every byte of every split section is
// moved, not rewritten, and the run aborts unless the section text can be
// accounted for afterwards. A PRD is a planning artifact people have spent real
// time on — silently dropping a section would be worse than not splitting.
//
// Usage:
//   node prd-split.mjs "<Name>" [--sections "A,B"] [--all] [--dry-run] [--force]
//
//   --sections   comma-separated ## headings to move out (default: the long-form
//                ones; the MVP/criteria spine always stays in the hub)
//   --all        move every eligible section, not just the defaults
//   --dry-run    print the plan, write nothing
//   --force      allow writing into an existing folder (still never overwrites)

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getVaultRoot } = require('./lib/vault-root.js');
const PRDP = require('./lib/prd-paths.js');

const VAULT = getVaultRoot();
const PRD_DIR = path.join(VAULT, '2. Areas', 'Product Manager', 'PRDs');

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);

const target = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
if (!target) {
  console.error('Usage: prd-split.mjs "<Name>" [--sections "A,B"] [--all] [--dry-run] [--force]');
  process.exit(1);
}
const DRY = has('--dry-run');
const FORCE = has('--force');
const ALL = has('--all');

// The spine stays in the hub no matter what. These are the sections braynee's
// own tooling reads (prd-seed parses Acceptance Criteria; the prd-seed-gate hook
// reads MVP Definition and Risks) and the ones a reader needs on first open.
// Keeping them together is also why the hub stays useful as a standalone read.
const HUB_ALWAYS = [
  'mvp definition',
  'acceptance criteria',
  'risks & open questions',
  'risks and open questions',
  'north star metric',
  'appendix / links',
  'appendix',
];

// Split by default: the long-form chapters that make a monolithic PRD unwieldy.
const DEFAULT_SPLIT = [
  'architecture',
  'user journeys',
  'personas / jobs-to-be-done',
  'personas / jtbd',
  'scope',
  'lean canvas',
  'milestones',
  'triple-purpose asset',
];

/** Split a markdown body into ## sections, preserving exact text. */
function splitSections(body) {
  const lines = body.split('\n');
  const out = [];
  let cur = { heading: null, title: '(preamble)', lines: [] };
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m && !/^###/.test(line)) {
      out.push(cur);
      cur = { heading: line, title: m[1].trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  out.push(cur);
  return out;
}

/** Filesystem-safe file name for a section title, kept human-readable. */
function sectionFileName(title) {
  return title.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

const hub = PRDP.resolvePrdHub(target, PRD_DIR);
if (!hub) {
  console.error(`PRD not found: ${target}`);
  process.exit(1);
}
if (PRDP.isFolderPrd(hub, PRD_DIR)) {
  console.error(`Already folder-form: ${path.relative(PRD_DIR, hub)}`);
  console.error(`Sections: ${PRDP.sectionFilesFor(hub, PRD_DIR).map(f => path.basename(f)).join(', ') || '(none)'}`);
  process.exit(1);
}

const raw = fs.readFileSync(hub, 'utf8');
const norm = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
const fmMatch = norm.match(/^---\n[\s\S]*?\n---\n?/);
const frontmatter = fmMatch ? fmMatch[0] : '';
const body = fmMatch ? norm.slice(fmMatch[0].length) : norm;

const sections = splitSections(body);
const wanted = opt('--sections');
const wantedList = wanted ? wanted.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;

const eligible = sections.filter((s) => {
  if (!s.heading) return false;                                   // preamble stays
  const t = s.title.toLowerCase();
  if (HUB_ALWAYS.includes(t)) return false;                       // spine stays
  if (wantedList) return wantedList.includes(t);
  if (ALL) return true;
  return DEFAULT_SPLIT.includes(t);
});

if (wantedList) {
  const known = new Set(sections.map((s) => s.title.toLowerCase()));
  for (const w of wantedList) {
    if (!known.has(w)) console.error(`  ! no such section: "${w}" — skipped`);
    else if (HUB_ALWAYS.includes(w)) console.error(`  ! "${w}" is part of the hub spine and stays put`);
  }
}

if (!eligible.length) {
  console.error('Nothing to split — no eligible sections matched.');
  console.error(`Sections present: ${sections.filter((s) => s.heading).map((s) => s.title).join(' | ')}`);
  process.exit(1);
}

const name = path.basename(hub, '.md');
const folder = path.join(PRD_DIR, name);
const newHub = path.join(folder, `${name}.md`);

console.log(`PRD:    ${path.relative(PRD_DIR, hub)}`);
console.log(`Folder: ${path.relative(PRD_DIR, folder)}/`);
console.log(`Hub:    ${path.relative(PRD_DIR, newHub)}`);
console.log(`Moving ${eligible.length} section(s):`);
for (const s of eligible) console.log(`   - ${s.title}  ->  ${sectionFileName(s.title)}.md`);
const staying = sections.filter((s) => s.heading && !eligible.includes(s));
console.log(`Staying in the hub: ${staying.map((s) => s.title).join(' | ') || '(none)'}`);

if (fs.existsSync(folder) && !FORCE) {
  console.error(`\nRefusing to write: ${folder} already exists (pass --force to add into it; existing files are never overwritten).`);
  process.exit(1);
}

// Rebuild the hub: the moved section becomes a heading + a wikilink, so the hub
// still reads as a complete table of contents rather than losing its structure.
const rebuilt = [];
for (const s of sections) {
  if (!s.heading) { rebuilt.push(s.lines.join('\n')); continue; }
  if (!eligible.includes(s)) { rebuilt.push(s.heading + '\n' + s.lines.join('\n')); continue; }
  const file = path.join(folder, `${sectionFileName(s.title)}.md`);
  rebuilt.push(`${s.heading}\n\n> Moved to ${PRDP.wikilinkFor(file, VAULT)}\n`);
}
const newHubText = frontmatter + rebuilt.join('\n');

// Accounting check BEFORE any write: every non-blank line of every moved section
// must exist in exactly one output. A split that quietly loses a paragraph is
// the one failure mode that matters here, and it is invisible in a diff of two
// files that were never compared.
const plannedFiles = eligible.map((s) => ({
  file: path.join(folder, `${sectionFileName(s.title)}.md`),
  title: s.title,
  text: `# ${s.title}\n` + s.lines.join('\n').replace(/^\n+/, '\n'),
}));

const originalLines = body.split('\n').map((l) => l.trim()).filter(Boolean);
const producedLines = new Set(
  [newHubText, ...plannedFiles.map((p) => p.text)]
    .join('\n').split('\n').map((l) => l.trim()).filter(Boolean),
);
const missing = originalLines.filter((l) => !producedLines.has(l));
if (missing.length) {
  console.error(`\nABORT — ${missing.length} line(s) would be lost. Nothing written.`);
  for (const l of missing.slice(0, 8)) console.error(`   lost: ${l.slice(0, 100)}`);
  process.exit(1);
}
console.log(`\nContent check: all ${originalLines.length} non-blank lines accounted for.`);

const collisions = plannedFiles.filter((p) => fs.existsSync(p.file));
if (collisions.length) {
  console.error(`Refusing to overwrite existing section file(s): ${collisions.map((c) => path.basename(c.file)).join(', ')}`);
  process.exit(1);
}

if (DRY) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

fs.mkdirSync(folder, { recursive: true });
for (const p of plannedFiles) {
  fs.writeFileSync(p.file, p.text.replace(/\n*$/, '\n'), 'utf8');
  console.log(`  wrote ${path.relative(PRD_DIR, p.file)}`);
}
fs.writeFileSync(newHub, newHubText.replace(/\n*$/, '\n'), 'utf8');
console.log(`  wrote ${path.relative(PRD_DIR, newHub)}`);

// Remove the original only after every new file is on disk, so an interrupted
// run leaves the source intact rather than a half-split PRD with no original.
if (path.resolve(hub) !== path.resolve(newHub)) {
  fs.unlinkSync(hub);
  console.log(`  removed ${path.relative(PRD_DIR, hub)} (content now under ${name}/)`);
}

console.log(`\nDone. Verify with:  node scripts/prd-audit.mjs`);
