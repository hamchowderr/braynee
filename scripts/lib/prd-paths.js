'use strict';

// prd-paths.js — the one place that decides what a PRD *is* on disk (cp-s4uw).
//
// A PRD comes in two shapes, and before this module the three tools disagreed
// about both:
//
//   monolithic:  PRDs/<Name>.md
//   folder:      PRDs/<Name>/<Name>.md   (hub)  +  sibling section files
//
// The folder shape gets created by hand whenever a PRD outgrows one file, but
// nothing in the tooling supported it:
//
//   * prd-seed resolved `PRDs/<Name>` to the DIRECTORY — fs.existsSync is true
//     for a directory — and then died with EISDIR on readFileSync. Folder PRDs
//     could not be seeded at all.
//   * prd-audit walked recursively and reported every section file as its own
//     PRD, so "Zapier SDK API Reference.md" was audited for a project backlink
//     and an Acceptance Criteria section it was never supposed to have.
//
// The hub is the file carrying `type: prd` frontmatter. Section files are its
// siblings and are NOT PRDs — they are chapters of one.

const fs = require('fs');
const path = require('path');

/** Read a file's leading frontmatter block, or '' when it has none. */
function frontmatterOf(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const m = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : '';
}

/** True when a markdown file declares itself a PRD hub. */
function isPrdHub(file) {
  return /^type:\s*prd\s*$/m.test(frontmatterOf(file));
}

/**
 * The hub file for a PRD directory, or null when the directory has none.
 *
 * Preference order matters: a folder whose hub is named after the folder is the
 * established convention (`<Name>/<Name>.md`), so that wins over a generic
 * index. Only then do we fall back to scanning for any `type: prd` file, which
 * covers folders whose hub was renamed.
 */
function hubForDir(dir) {
  const base = path.basename(dir);
  const preferred = [
    path.join(dir, `${base}.md`),
    path.join(dir, 'index.md'),
    path.join(dir, '_index.md'),
  ];
  for (const p of preferred) if (fs.existsSync(p) && isPrdHub(p)) return p;
  // A folder PRD whose hub is not named after the folder: take the only
  // `type: prd` file if there is exactly one. More than one is ambiguous and
  // silently guessing would attach issues to the wrong document.
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const hubs = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => path.join(dir, e.name))
    .filter(isPrdHub);
  if (hubs.length === 1) return hubs[0];
  // Last resort for a folder that has files but no frontmatter at all yet:
  // honour the naming convention so a half-scaffolded PRD is still addressable.
  for (const p of preferred) if (fs.existsSync(p)) return p;
  return null;
}

/**
 * Resolve a user-supplied PRD name to its hub file.
 * Accepts a path, a bare name, a name with spaces, or a folder name.
 * Returns null rather than guessing when nothing matches.
 */
function resolvePrdHub(target, prdDir) {
  if (!target) return null;

  // An explicit path wins — but a directory must still resolve to its hub, not
  // be handed back as-is. That was the EISDIR crash.
  if (fs.existsSync(target)) {
    const abs = path.resolve(target);
    return fs.statSync(abs).isDirectory() ? hubForDir(abs) : abs;
  }

  const dashed = target.replace(/\s+/g, '-');

  // Match against the real directory listing rather than probing paths with
  // fs.existsSync. On Windows the filesystem is case-insensitive, so probing
  // `PRDs/duo` succeeds and returns a path spelled "duo/duo.md" for a folder
  // actually named "Duo" — a path that works locally but does not match the
  // on-disk name the vault, wikilinks, or a case-sensitive filesystem use.
  // Reading entries gives the canonical spelling on every platform.
  let entries;
  try {
    entries = fs.readdirSync(prdDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const wants = [target.toLowerCase(), dashed.toLowerCase()];
  // Exact (case-differing) name first, then the dashed variant — checked in one
  // pass per priority so a file and a directory of the same name resolve
  // deterministically rather than by readdir order.
  for (const want of wants) {
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase() === `${want}.md`) return path.join(prdDir, e.name);
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name.toLowerCase() === want) return hubForDir(path.join(prdDir, e.name));
    }
  }
  return null;
}

/**
 * Every PRD hub under prdDir — one entry per PRD, never per file.
 * A folder contributes exactly its hub; its section files are not PRDs.
 */
function listPrdHubs(prdDir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(prdDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(prdDir, e.name);
    if (e.isDirectory()) {
      const hub = hubForDir(p);
      if (hub) out.push(hub);
    } else if (e.name.endsWith('.md')) {
      out.push(p);
    }
  }
  return out.sort();
}

/** True when this hub is the folder form (has sibling section files). */
function isFolderPrd(hubPath, prdDir) {
  return path.resolve(path.dirname(hubPath)) !== path.resolve(prdDir);
}

/**
 * Section files belonging to a folder PRD's hub — its markdown siblings,
 * recursively, excluding the hub itself. Empty for a monolithic PRD.
 */
function sectionFilesFor(hubPath, prdDir) {
  if (!isFolderPrd(hubPath, prdDir)) return [];
  const dir = path.dirname(hubPath);
  const out = [];
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
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md') && path.resolve(p) !== path.resolve(hubPath)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * The full text a PRD's content spans: hub first, then every section file.
 * Seeding reads this rather than the hub alone, because splitting a PRD may
 * move Acceptance Criteria into a section file — and a seeder that silently
 * found zero criteria there would look like a PRD with nothing to build.
 */
function prdFullText(hubPath, prdDir) {
  const parts = [fs.readFileSync(hubPath, 'utf8')];
  for (const f of sectionFilesFor(hubPath, prdDir)) {
    try {
      parts.push(`\n\n<!-- section: ${path.basename(f, '.md')} -->\n` + fs.readFileSync(f, 'utf8'));
    } catch {
      /* an unreadable section is reported by the caller via sectionFilesFor */
    }
  }
  return parts.join('\n');
}

/** Vault-root-relative wikilink target for a section file, Obsidian style. */
function wikilinkFor(file, vaultRoot) {
  const rel = path.relative(vaultRoot, file).replace(/\\/g, '/').replace(/\.md$/, '');
  return `[[${rel}|${path.basename(file, '.md')}]]`;
}

module.exports = {
  frontmatterOf,
  isPrdHub,
  hubForDir,
  resolvePrdHub,
  listPrdHubs,
  isFolderPrd,
  sectionFilesFor,
  prdFullText,
  wikilinkFor,
};
