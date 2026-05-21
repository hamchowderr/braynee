// vault-root.js
// Shared resolver for the Obsidian vault root. Used by hooks, scripts, and
// .mjs skills (via createRequire). Mirrors the Python resolver in
// skills/session-backfill/scripts/backfill.py so behavior is consistent
// across all entry points.
//
// Resolution order:
//   1. $BRAYNEE_VAULT (canonical override)
//   2. $OBSIDIAN_VAULT (back-compat)
//   3. Common candidates that contain a `.obsidian` directory
//   4. Fallback: ~/Obsidian Vault (so a brand-new vault still works)

const fs = require('fs');
const os = require('os');
const path = require('path');

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
    path.join(home, 'OneDrive', 'Obsidian Vault'),
    path.join(home, 'iCloud Drive', 'Obsidian Vault'),
  ];
  for (const c of candidates) {
    if (hasObsidian(c)) return c;
  }
  return path.join(home, 'Obsidian Vault');
}

module.exports = { getVaultRoot };
