#!/usr/bin/env node
'use strict';

// hook-logger.js — the one inspectable channel for hook diagnostics.
//
// Hooks must never throw and must never add noise to the user's turn, so they
// swallow errors. That left failures completely invisible: a hook could stop
// working and nobody would know until someone measured its output (cp-ccsh.11 /
// B9 counted 90 empty catch blocks across 41 hook files). This logger is where
// a swallowed error goes so the swallow keeps a record.
//
// Nothing here writes to stdout — that would corrupt hook protocol output.
// stderr is used only as a last resort when the log file cannot be written.
//
// $BRAYNEE_HOOK_LOG overrides the log path (cp-ccsh.10 — without it this module
// could not be tested without appending to the user's real log). Resolved per
// call rather than at module load so a test can set it after require.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_SIZE = 1024 * 1024; // 1MB — rotate beyond this

function logFile() {
  const override = process.env.BRAYNEE_HOOK_LOG;
  if (override) return override;
  return path.join(os.homedir(), '.claude', 'braynee-hooks.log');
}

// Coerce anything to a string without trusting it. B9 routes caught values here,
// and a value whose toString() throws (or an exotic object) must not take the
// hook down — string interpolation alone would, since it runs before any try.
function safe(value) {
  try {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return String(value);
    if (value instanceof Error) return value.message || value.name || 'Error';
    const s = String(value);
    return typeof s === 'string' ? s : '[unstringifiable]';
  } catch {
    return '[unstringifiable]';
  }
}

function write(level, hookName, message) {
  // Built defensively and on ONE line: a multi-line message would otherwise
  // break the one-record-per-line format the log is read with.
  const line = `${new Date().toISOString()} ${level} [${safe(hookName)}] ` +
    `${safe(message).replace(/\r?\n/g, ' ')}\n`;
  const file = logFile();
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_SIZE) {
      try { fs.renameSync(file, file + '.old'); } catch { /* keep appending */ }
    }
    fs.appendFileSync(file, line, 'utf8');
  } catch {
    // The directory may not exist yet (an override path, or a fresh ~/.claude).
    // Try once to create it before falling back to stderr.
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line, 'utf8');
    } catch {
      try { process.stderr.write(line); } catch { /* nothing left to try */ }
    }
  }
}

// `debug` is the level for swallowed best-effort failures (B9). It writes to the
// log like every other level — the log file is not user-visible output, and a
// silent-by-default debug level would defeat the point of recording them. Volume
// is bounded by the 1MB rotation above, and these fire only on actual failures.
module.exports = {
  debug: (hook, msg) => write('DEBUG', hook, msg),
  info: (hook, msg) => write('INFO ', hook, msg),
  warn: (hook, msg) => write('WARN ', hook, msg),
  error: (hook, msg) => write('ERROR', hook, msg),
  // Exported for tests and for callers that want to tell the user where to look.
  logFile,
  MAX_SIZE,
};
