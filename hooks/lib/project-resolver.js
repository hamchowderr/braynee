// project-resolver.js — map a cwd/repo slug or bd project name to the real vault
// project note under "1. Projects/" (or "4. Archives/Projects/"), so sessions,
// transcripts, and task notes carry a graph-visible [[...]] link instead of a
// non-resolving slug.
//
// Used by:
//   - session-export-qmd.js  (transcript `project:` frontmatter)
//   - tasknotes-mirror.js     (repoint mtn's [[projects/<slug>]] to the real note)
//
// Matching order: explicit alias (codenames / repo-slugs that don't match the
// note name) -> alphanumeric-normalized exact -> safe longest-prefix.

const fs = require('fs');
const path = require('path');

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// codename / repo-slug -> real vault note (relpath without .md)
const ALIAS = {
  fivemstudio: '1. Projects/myRP.build/myRP.build',
  fivemstudioweb: '1. Projects/myRP.build/myRP.build',
  myrpbuild: '1. Projects/myRP.build/myRP.build',
  chowderr: '1. Projects/chowderr.dev',
  brainy: '1. Projects/Braynee/Braynee',
  brainyweb: '1. Projects/Braynee/Braynee',
  agentplatform: '1. Projects/Claude Agent Studio',
  doltmastralab: '1. Projects/Mastra/Mastra Lab',
  ghlbuilder: '1. Projects/Mastra/Mastra GHL',
  templatemastrabase: '1. Projects/Mastra/Mastra Base',
  templatemastrarag: '1. Projects/Mastra/Mastra RAG',
  templatemastranca: '1. Projects/Mastra/Mastra NCAT',
  templatemastrancat: '1. Projects/Mastra/Mastra NCAT',
  templatemastravoice: '1. Projects/Mastra/Mastra Voice',
  voicefoundation: '1. Projects/Mastra/Voice Builder',
};

function buildIndex(vaultDir) {
  const pages = new Map(); // norm(basename) -> relpath w/o .md
  const walk = (dir) => {
    let es;
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!e.name.endsWith('.md')) continue;
      const base = e.name.replace(/\.md$/, '');
      if (base.startsWith('_')) continue;
      const k = norm(base);
      if (k && !pages.has(k)) pages.set(k, path.relative(vaultDir, f).split(path.sep).join('/').replace(/\.md$/, ''));
    }
  };
  walk(path.join(vaultDir, '1. Projects'));
  walk(path.join(vaultDir, '4. Archives', 'Projects'));
  return pages;
}

// Returns the vault relpath (no .md) of the matching project note, or null.
function resolveProjectLink(name, vaultDir) {
  try {
    const n = norm(name);
    if (!n) return null;
    if (ALIAS[n]) return fs.existsSync(path.join(vaultDir, ALIAS[n] + '.md')) ? ALIAS[n] : null;
    const pages = buildIndex(vaultDir);
    if (pages.has(n)) return pages.get(n);
    let best = null;
    for (const [k, r] of pages) {
      if (k.length >= 6 && n.startsWith(k) && n.length > k.length) {
        if (!best || k.length > best.k.length) best = { k, r };
      }
    }
    return best ? best.r : null;
  } catch {
    return null;
  }
}

module.exports = { resolveProjectLink, norm };
