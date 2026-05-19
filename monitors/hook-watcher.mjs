#!/usr/bin/env node
/**
 * Monitor: tail braynee-hooks.log and emit Claude notifications for hook errors.
 *
 * Runs as a long-lived process. Each stdout line becomes a Claude notification.
 * Watches for ERROR-level entries and emits them with actionable hints.
 */

import { existsSync, statSync, createReadStream } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const LOG_FILE = join(homedir(), '.claude', 'braynee-hooks.log');
const POLL_MS = 5000;

// Common patterns → hint text
const HINTS = [
  [/Cannot find module/i,       'Possible ${CLAUDE_PLUGIN_ROOT} resolution failure — verify hook paths in hooks.json'],
  [/ENOENT.*statusline/i,       'statusline-live.json not found — vault path detection may be broken'],
  [/ENOENT/i,                   'File not found — check that the vault path and Sessions/ folder exist'],
  [/SyntaxError/i,              'JSON parse error — hook received malformed input'],
  [/EPERM|EACCES/i,             'Permission denied — check vault directory write access'],
  [/qmd-wrapper.*not found/i,   'QMD not installed — run /braynee:health self-test'],
];

function getHint(message) {
  for (const [pattern, hint] of HINTS) {
    if (pattern.test(message)) return ` → ${hint}`;
  }
  return '';
}

// Pattern detection — track recent errors per hook to surface chronic failures.
// If a single hook fires >3 errors within 24h, emit a "chronic failure" notification.
const CHRONIC_THRESHOLD = 3;
const CHRONIC_WINDOW_MS = 24 * 60 * 60 * 1000;
const errorHistory = new Map(); // hookName → [{ timestamp, message }]
const chronicNotified = new Set(); // hookName already notified about chronic state

function trackError(hookName, message) {
  const now = Date.now();
  const cutoff = now - CHRONIC_WINDOW_MS;

  let history = errorHistory.get(hookName) || [];
  history = history.filter(e => e.timestamp >= cutoff);
  history.push({ timestamp: now, message });
  errorHistory.set(hookName, history);

  if (history.length >= CHRONIC_THRESHOLD && !chronicNotified.has(hookName)) {
    chronicNotified.add(hookName);
    process.stdout.write(
      `[braynee] CHRONIC: ${hookName} has failed ${history.length}x in last 24h — investigate. Run /braynee:health self-test\n`
    );
  } else if (history.length < CHRONIC_THRESHOLD && chronicNotified.has(hookName)) {
    // Recovered — clear the flag so we'll notify again if it goes chronic
    chronicNotified.delete(hookName);
  }
}

let lastPos = 0;

// Start from end of file — don't replay past errors on monitor startup
if (existsSync(LOG_FILE)) {
  try { lastPos = statSync(LOG_FILE).size; } catch {}
}

function poll() {
  if (!existsSync(LOG_FILE)) return;

  let size;
  try { size = statSync(LOG_FILE).size; } catch { return; }

  // File was rotated (new file smaller than last position)
  if (size < lastPos) lastPos = 0;
  if (size === lastPos) return;

  const chunks = [];
  const stream = createReadStream(LOG_FILE, { start: lastPos, end: size - 1 });

  stream.on('data', chunk => chunks.push(chunk));
  stream.on('error', () => {});
  stream.on('end', () => {
    lastPos = size;
    const newContent = Buffer.concat(chunks).toString('utf8');

    for (const line of newContent.split('\n')) {
      if (!line.trim()) continue;
      if (!line.includes('ERROR')) continue;

      // Parse: "2026-05-05T... ERROR [hook-name] message"
      const m = line.match(/ERROR\s+\[([^\]]+)\]\s+(.+)/);
      if (!m) continue;

      const [, hookName, message] = m;
      const hint = getHint(message);
      process.stdout.write(`[braynee] Hook error in ${hookName}: ${message}${hint}\n`);
      trackError(hookName, message);
    }
  });
}

setInterval(poll, POLL_MS);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
