// vault-root.js
// Shared resolver for the Obsidian vault root. Used by hooks, scripts, and
// .mjs skills (via createRequire). Mirrors the Python resolver in
// skills/session-backfill/scripts/backfill.py so behavior is consistent
// across all entry points.
//
// Resolution order:
//   1. $BRAYNEE_VAULT (canonical override — the opt-in for non-Obsidian hosts)
//   2. $OBSIDIAN_VAULT (back-compat)
//   3. Common candidates that are a braynee vault (`.obsidian/` OR the PARA
//      skeleton) — so a non-Obsidian markdown app (Logseq, Foam, Dendron,
//      Shockwave, plain folder) sitting at a common path is still found
//   4. Fallback: ~/Obsidian Vault (so a brand-new vault still works)

const fs = require('fs');
const os = require('os');
const path = require('path');

// The numbered PARA folders braynee scaffolds. Their presence marks a braynee
// vault even with no `.obsidian/` (non-Obsidian markdown apps have none).
const PARA_MARKERS = ['1. Projects', '2. Areas', '3. Resources', '4. Archives'];

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isVaultDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function hasObsidian(p) {
  try { return fs.statSync(path.join(p, '.obsidian')).isDirectory(); } catch { return false; }
}

// ≥2 of the numbered PARA folders → a braynee vault. Requiring two avoids a
// false positive on an arbitrary folder that happens to hold one common-named
// subdir (e.g. a stray "2. Areas").
function looksLikeBrayneeVault(p) {
  let hits = 0;
  for (const m of PARA_MARKERS) {
    try { if (fs.statSync(path.join(p, m)).isDirectory()) hits++; } catch {}
  }
  return hits >= 2;
}

// A directory is a braynee vault if Obsidian marks it OR it carries the PARA
// skeleton. Host-agnostic: Obsidian is one signal, not the only one.
function isBrayneeVault(p) {
  return hasObsidian(p) || looksLikeBrayneeVault(p);
}

function getVaultRoot() {
  for (const envVar of ['BRAYNEE_VAULT', 'OBSIDIAN_VAULT']) {
    const val = process.env[envVar];
    if (val) {
      const expanded = expandHome(val);
      if (isVaultDir(expanded)) return expanded;
    }
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Obsidian Vault'),
    path.join(home, 'vault'),
    path.join(home, 'ObsidianVault'),
    path.join(home, 'Documents', 'Obsidian Vault'),
    path.join(home, 'Documents', 'vault'),
    path.join(home, 'Documents', 'Notes'),
    path.join(home, 'Notes'),
    path.join(home, 'OneDrive', 'Obsidian Vault'),
    path.join(home, 'iCloud Drive', 'Obsidian Vault'),
  ];
  for (const c of candidates) {
    if (isBrayneeVault(c)) return c;
  }
  return path.join(home, 'Obsidian Vault');
}

module.exports = { getVaultRoot, isBrayneeVault, looksLikeBrayneeVault, hasObsidian };
