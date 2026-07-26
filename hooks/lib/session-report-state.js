'use strict';

// session-report-state.js — per-session "have I already reported this?" memory.
//
// Extracted from cwd-changed-check.js (cp-hdpr.2) so directory-added-check.js
// can share it instead of carrying a second copy that drifts. Both hooks answer
// the same question: a location-related thing happened, have I already told the
// model about THIS one in THIS session?
//
// Keyed by session id, valued by the last thing reported. Bounded to STATE_MAX
// entries so a long-lived machine cannot grow the file without limit. Every
// function is best-effort and never throws: a hook must not die because a state
// file is unreadable, and losing the memory only costs a duplicate report.

const fs = require('fs');
const os = require('os');
const path = require('path');

const log = require(path.join(__dirname, 'hook-logger.js'));
const LOG_NAME = 'session-report-state';

const STATE_MAX = 200;

function stateFile(name) {
  try { return path.join(os.homedir(), '.claude', name); }
  catch { return null; }
}

function readState(file) {
  if (!file) return {};
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

function writeState(file, map) {
  if (!file || !map || typeof map !== 'object') return;
  try {
    const keys = Object.keys(map);
    if (keys.length > STATE_MAX) {
      for (const k of keys.slice(0, keys.length - STATE_MAX)) delete map[k];
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map));
  } catch (e) {
    // This file IS the dedup memory. A failed write makes every run look like
    // the first, so one-shot notices repeat on every event.
    log.debug(LOG_NAME, `could not persist report state to ${file}: ${e && e.message}`);
  }
}

// True when `value` has NOT already been reported for `sessionId`, recording it
// as reported. Paths are compared resolved so C:/x and C:\x\ are one value.
// With no session id there is nothing to dedup against, so it always reports —
// a duplicate note is strictly better than a swallowed one.
function shouldReport(file, sessionId, value) {
  if (!value) return false;
  if (!sessionId || !file) return true;
  let norm = String(value);
  try { norm = path.resolve(norm); } catch { /* keep the raw string */ }
  const state = readState(file);
  const prev = state[sessionId];
  if (prev) {
    let prevNorm = String(prev);
    try { prevNorm = path.resolve(prevNorm); } catch { /* keep the raw string */ }
    if (prevNorm === norm) return false;
  }
  state[sessionId] = norm;
  writeState(file, state);
  return true;
}

module.exports = { stateFile, readState, writeState, shouldReport, STATE_MAX };
