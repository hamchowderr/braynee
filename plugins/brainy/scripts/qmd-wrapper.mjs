#!/usr/bin/env node
// qmd-wrapper.mjs — cross-platform wrapper for QMD (Query Markup Documents)
//
// Locates the QMD JS source in the global npm modules and invokes node on it
// directly. This avoids the platform-specific shim issues (the npm-installed
// `qmd` shim depends on /bin/sh which is not in cmd.exe's PATH on Windows).
//
// Requires: `npm i -g @tobilu/qmd`
//
// Usage: node qmd-wrapper.mjs <command> [args...]
//   node qmd-wrapper.mjs search "supabase RLS"
//   node qmd-wrapper.mjs vsearch "auth flow decisions"
//   node qmd-wrapper.mjs query "what did we decide about ..."
//   node qmd-wrapper.mjs get "1. Projects/Minions.md"

import { execSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

function findQmdJs() {
  // Try `npm root -g` to locate the global modules dir
  let globalRoot;
  try {
    globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
  const qmdPath = join(globalRoot, '@tobilu', 'qmd', 'dist', 'cli', 'qmd.js');
  return existsSync(qmdPath) ? qmdPath : null;
}

const qmdJs = findQmdJs();
if (!qmdJs) {
  process.stderr.write(
    `qmd not found. Install with: npm i -g @tobilu/qmd\n`
  );
  process.exit(127);
}

const res = spawnSync(process.execPath, [qmdJs, ...process.argv.slice(2)], {
  stdio: 'inherit',
  timeout: 60_000,
});

process.exit(res.status ?? 1);
