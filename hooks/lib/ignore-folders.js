// ignore-folders.js
// Shared helper: which folder names must NEVER auto-create a 1. Projects note.
//
// session-auto-track.js auto-creates `1. Projects/<Name>.md` the first time a
// session starts in a code folder that has no matching project note. That is
// right for real repos, but when a session is launched from a generic PARENT
// or working dir — `~/code` itself, `scripts`, `web`, a temp/sandbox dir — it
// stamps out a stub project with a placeholder description and empty sections.
// Those litter the active Projects list (the exact same noise class as the
// smoke-test stubs). This module decides which folder basenames to skip.
//
// IMPORTANT: this only gates AUTO-creation. session-auto-track calls
// findProjectName() FIRST; if the user has manually created a project note for
// the folder (even one named "web" or "scripts"), it tracks normally. So the
// ignore-list never blocks a real, intentionally-tracked project — it only
// stops braynee from inventing one.
//
// Sources, merged (all lowercased, case-insensitive match):
//   1. DEFAULT_IGNORE_FOLDERS — universal generic/parent dir names.
//   2. BRAYNEE_IGNORE_FOLDERS env var — comma-separated extras (handy for tests
//      and per-machine tweaks).
//   3. ~/.claude/braynee-ignore-folders.json — optional JSON array of strings,
//      the durable per-user override (e.g. add "claude-plugins", "agents").
//
// Pure + synchronous; a malformed config never throws into the hook.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Universally-generic folder basenames — never a sellable/trackable product on
// their own. Kept deliberately conservative: anything that is plausibly a real
// product name (app, api, agent, ...) is left OUT and handled by the
// manual-project-note override instead.
const DEFAULT_IGNORE_FOLDERS = [
  'code', 'codes', 'repo', 'repos', 'project', 'projects',
  'src', 'source', 'dev', 'development', 'work', 'workspace',
  'sandbox', 'scratch', 'tmp', 'temp', 'test', 'tests',
  'web', 'www', 'site', 'docs', 'scripts', 'bin', 'lib',
  'build', 'dist', 'node_modules', 'desktop', 'documents', 'downloads',
];

// Path to the optional per-user override file. homeDir is injectable for tests.
function configPath(homeDir) {
  const home = homeDir || os.homedir();
  return path.join(home, '.claude', 'braynee-ignore-folders.json');
}

// Build the merged Set of lowercased folder names to skip auto-create for.
// env / homeDir are injectable (mirrors the projects-root.js pattern) so this
// is unit-testable without touching the real environment.
function loadIgnoreFolders(env, homeDir) {
  env = env || process.env;
  const set = new Set(DEFAULT_IGNORE_FOLDERS.map((s) => s.toLowerCase()));

  const envVal = env.BRAYNEE_IGNORE_FOLDERS;
  if (typeof envVal === 'string' && envVal.trim()) {
    for (const n of envVal.split(',')) {
      const t = n.trim().toLowerCase();
      if (t) set.add(t);
    }
  }

  try {
    const cfg = configPath(homeDir);
    if (fs.existsSync(cfg)) {
      const arr = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      if (Array.isArray(arr)) {
        for (const n of arr) {
          if (typeof n === 'string') {
            const t = n.trim().toLowerCase();
            if (t) set.add(t);
          }
        }
      }
    }
  } catch {
    // A broken override file must never break session tracking — fall back to
    // defaults + env only.
  }

  return set;
}

// Is `folderName` (a folder basename) one we must NOT auto-create a project for?
function isIgnoredFolder(folderName, env, homeDir) {
  if (!folderName || typeof folderName !== 'string') return false;
  return loadIgnoreFolders(env, homeDir).has(folderName.trim().toLowerCase());
}

module.exports = {
  DEFAULT_IGNORE_FOLDERS,
  configPath,
  loadIgnoreFolders,
  isIgnoredFolder,
};
