#!/usr/bin/env node
/**
 * Monitor: Vault Inbox watcher.
 * Polls the vault Inbox/ directory every 60s. Emits a notification line
 * when the item count crosses accumulation thresholds (1, 5, 10, 20).
 * Emits once when the inbox clears.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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

let lastCount = -1;
let lastNotifiedThreshold = -1;

function check() {
  if (!existsSync(inboxDir)) return;
  let files;
  try { files = readdirSync(inboxDir).filter(f => f.endsWith('.md')); }
  catch { return; }
  const count = files.length;

  if (count === lastCount) return;
  lastCount = count;

  if (count === 0 && lastNotifiedThreshold > 0) {
    lastNotifiedThreshold = -1;
    process.stdout.write('Vault inbox is now clear\n');
    return;
  }

  for (const t of THRESHOLDS) {
    if (count >= t && lastNotifiedThreshold < t) {
      lastNotifiedThreshold = t;
      if (count === 1) {
        process.stdout.write('Vault inbox has 1 unprocessed item — run /brainy:recall or /brainy:daily to process it\n');
      } else {
        process.stdout.write(`Vault inbox has ${count} items — consider processing with /brainy:recall or /brainy:daily\n`);
      }
    }
  }
}

check();
setInterval(check, 60_000);
