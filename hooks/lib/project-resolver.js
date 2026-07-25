// project-resolver.js — map a cwd/repo slug or bd project name to the real vault
// project note under "1. Projects/" (or "4. Archives/Projects/"), so sessions,
// transcripts, and task notes carry a graph-visible [[...]] link instead of a
// non-resolving slug.
//
// Used by:
//   - session-export-qmd.js  (transcript `project:` frontmatter)
//   - tasknotes-mirror.js     (repoint mtn's [[projects/<slug>]] to the real note)
//
// Matching order: explicit alias from runtime config (codenames / repo-slugs
// that don't match the note name) -> alphanumeric-normalized exact -> safe
// longest-prefix. Everything except the alias table is user-independent.

const fs = require('fs');
const os = require('os');
const path = require('path');

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Aliases are USER DATA, not code (cp-ccsh.5 / B4). They used to ship as a
// hard-coded table of one particular vault owner's repo slugs and note paths,
// which is dead weight for everyone else and actively harmful when a slug like
// `brainy` is a plausible repo name in someone else's vault: it would resolve to
// a note that does not exist there and write a broken [[wikilink]] into session
// and transcript frontmatter. The rest of this module is already universal.
//
// Loaded at resolve time from the first of these that exists; absent → no
// aliases, and resolution falls back to the vault index alone:
//   1. $BRAYNEE_PROJECT_ALIASES              (explicit file path; used by tests)
//   2. <vault>/.braynee/project-aliases.json (travels with the vault it maps)
//   3. ~/.claude/braynee/project-aliases.json (machine-wide)
//
// $BRAYNEE_PROJECT_ALIASES is authoritative when set: it does NOT fall through
// to the other two if the file is missing. Otherwise a test asking for "no
// aliases" would silently pick up the machine-wide file.
//
// Shape — a flat slug → vault relpath (no .md) object. Keys are normalized on
// load, so `my-repo`, `My Repo` and `myrepo` are all the same key:
//   { "some-repo-slug": "1. Projects/Some Project",
//     "other-slug":     "1. Projects/Group/Other Project" }
const ALIAS_FILENAME = 'project-aliases.json';

function aliasFilePaths(vaultDir) {
  if (process.env.BRAYNEE_PROJECT_ALIASES) return [process.env.BRAYNEE_PROJECT_ALIASES];
  const candidates = [];
  if (vaultDir) candidates.push(path.join(vaultDir, '.braynee', ALIAS_FILENAME));
  candidates.push(path.join(os.homedir(), '.claude', 'braynee', ALIAS_FILENAME));
  return candidates;
}

// Never throws and never partially applies: a malformed file yields {} so a bad
// edit degrades to index-only resolution instead of breaking every hook.
function loadAliases(vaultDir) {
  for (const p of aliasFilePaths(vaultDir)) {
    let raw;
    try {
      if (!fs.existsSync(p)) continue;
      raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const nk = norm(k);
      if (nk && typeof v === 'string' && v.trim()) out[nk] = v.trim();
    }
    return out;
  }
  return {};
}

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
    const alias = loadAliases(vaultDir);
    // An alias still has to point at a note that exists — a stale mapping
    // resolves to null rather than emitting a broken wikilink.
    if (alias[n]) return fs.existsSync(path.join(vaultDir, alias[n] + '.md')) ? alias[n] : null;
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

module.exports = { resolveProjectLink, norm, loadAliases, aliasFilePaths, ALIAS_FILENAME };
