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
import { homedir } from 'os';

function findQmdJs() {
  // Try `npm root -g` to locate the global modules dir
  let globalRoot;
  try {
    globalRoot = execSync('npm root -g', { encoding: 'utf8', windowsHide: true }).trim();
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

// Fast, hook-driven commands (search/vsearch/query/get) must never hang, so they
// keep the 60s cap. Maintenance commands (embed/update/cleanup/bench) legitimately
// run for minutes on a large corpus — capping them silently SIGTERMs the job
// mid-batch (exit 1, no error), so they run uncapped.
const args = process.argv.slice(2);
const LONG_RUNNING = new Set(['embed', 'update', 'cleanup', 'bench']);
// qmd derives its cache/index dir from $HOME (NOT os.homedir). On Windows,
// PowerShell and Claude-Code-spawned hooks leave HOME unset, so qmd silently
// falls back to a /tmp index — split-brained from the ~/.cache index Git Bash
// gets. Pin HOME so every qmd invocation reads/writes ONE index, matching the
// ~/.cache/qmd location braynee's reindex control files already assume.
const spawnOpts = {
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, HOME: process.env.HOME || homedir() },
};
if (!LONG_RUNNING.has(args[0])) spawnOpts.timeout = 60_000;

const res = spawnSync(process.execPath, [qmdJs, ...args], spawnOpts);

process.exit(res.status ?? 1);
