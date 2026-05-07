#!/usr/bin/env node
/**
 * Monitor: Vault Inbox watcher.
 * Polls the vault Inbox/ directory every 60s. Emits a notification line
 * when STALE items (older than 7 days) cross thresholds (1, 5, 10, 20).
 * Fresh captures (<7 days) don't nag.
 */

import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

function findVault() {
  const livePath = join(homedir(), '.claude', 'statusline-live.json');
  if (existsSync(livePath)) {
    try {
      const live = JSON.parse(readFileSync(livePath, 'utf8'));
      if (live.vault && existsSync(live.vault)) return live.vault;
    } catch {}
  }
  for (const p of [
    join(homedir(), 'Obsidian Vault'),
    join(homedir(), 'vault'),
    join(homedir(), 'Documents', 'Obsidian Vault'),
    join(homedir(), 'OneDrive', 'Obsidian Vault'),
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

const vault = findVault();
if (!vault) process.exit(0);

const inboxDir = join(vault, 'Inbox');
const THRESHOLDS = [1, 5, 10, 20];

let lastStaleCount = -1;
let lastNotifiedThreshold = -1;

function check() {
  if (!existsSync(inboxDir)) return;
  let files;
  try { files = readdirSync(inboxDir).filter(f => f.endsWith('.md')); }
  catch { return; }

  const now = Date.now();
  let staleCount = 0;
  for (const f of files) {
    try {
      const st = statSync(join(inboxDir, f));
      if (now - st.mtimeMs >= STALE_THRESHOLD_MS) staleCount++;
    } catch {}
  }

  if (staleCount === lastStaleCount) return;
  lastStaleCount = staleCount;

  if (staleCount === 0 && lastNotifiedThreshold > 0) {
    lastNotifiedThreshold = -1;
    process.stdout.write('Vault inbox: no stale items (everything is fresh or processed)\n');
    return;
  }

  for (const t of THRESHOLDS) {
    if (staleCount >= t && lastNotifiedThreshold < t) {
      lastNotifiedThreshold = t;
      const total = files.length;
      if (staleCount === 1) {
        process.stdout.write(`Vault inbox has 1 STALE item (>7d old, ${total} total) — process with /brainy:recall or /brainy:daily\n`);
      } else {
        process.stdout.write(`Vault inbox has ${staleCount} STALE items (>7d old, ${total} total) — process with /brainy:recall or /brainy:daily\n`);
      }
    }
  }
}

check();
setInterval(check, 60_000);
