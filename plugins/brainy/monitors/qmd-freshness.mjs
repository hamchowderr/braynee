#!/usr/bin/env node
/**
 * Monitor: QMD search index freshness.
 * Checks QMD index age on startup and every 4 hours.
 * Emits a notification line when the index is more than 24h stale.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

import { fileURLToPath as _fu } from 'url';
import { dirname as _dn } from 'path';
const __dirname = _dn(_fu(import.meta.url));
const qmdPath = join(__dirname, '..', 'scripts', 'qmd-wrapper.mjs');
if (!existsSync(qmdPath)) process.exit(0);

const CHECK_INTERVAL_MS  = 4 * 60 * 60 * 1000; // 4 hours
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
let lastNotified = 0;

function check() {
  let status;
  try {
    const raw = execSync(`node "${qmdPath}" status --json`, {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    status = JSON.parse(raw);
  } catch {
    return;
  }

  const collections = status.collections || [];
  const lastIndexed = Math.max(...collections.map(c => c.lastIndexed || 0), 0);
  if (lastIndexed === 0) return;

  const ageMs = Date.now() - lastIndexed;
  if (ageMs < STALE_THRESHOLD_MS) return;

  const now = Date.now();
  if (now - lastNotified < CHECK_INTERVAL_MS) return;
  lastNotified = now;

  const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));
  const docCount = collections.reduce((sum, c) => sum + (c.documents || 0), 0);
  const qmdWrapper = join(__dirname, '..', 'scripts', 'qmd-wrapper.mjs');
  process.stdout.write(
    `QMD search index is ${ageDays}d stale (${docCount} docs) — run: node "${qmdWrapper}" index\n`
  );
}

check();
setInterval(check, CHECK_INTERVAL_MS);
