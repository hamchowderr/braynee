// dolt-guard.js
// HARD SAFETY CAP — braynee must NEVER be able to flood the machine with dolt
// sql-server processes.
//
// Why this exists: braynee runs `bd` from many hooks (often after a tool use).
// When the shared Dolt server is wedged (or a project is in per-project mode),
// each `bd` invocation can make bd auto-start a *new* dolt sql-server. With no
// upper bound, a burst of bd activity piles up dozens of ~140 MB dolt processes
// until the machine runs out of memory. (Observed 2026-06-06: 14 → 77+, ~11 GB.)
//
// This guard is the universal backstop: before braynee does anything that could
// start another dolt server, it asks `overCap()`. Once the machine already has an
// abnormal number of dolt servers, braynee refuses — bounding ANY runaway (from
// any current or future bug) to the cap. The real triggers are fixed elsewhere
// (statusline reads the JSONL instead of bd); this just guarantees a crash-level
// flood can never happen again.
//
// Pure-ish: the only side effect is a tiny cached-count file. Cross-platform.

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Max dolt servers tolerated before braynee stops doing anything that could
// start more. A healthy machine has ~1–3 (the shared server + maybe one other).
// Overridable for tests / power users.
const CAP = Number(process.env.BRAYNEE_DOLT_CAP) > 0 ? Number(process.env.BRAYNEE_DOLT_CAP) : 20;

const CACHE_FILE = path.join(os.homedir(), '.claude', 'braynee-dolt-count.json');
const CACHE_MS = 5000; // don't enumerate processes more than once per 5s

// Count running dolt processes. Returns -1 when it genuinely cannot tell (so
// callers can choose to proceed rather than block on a counting failure).
function countDoltProcesses(runner) {
  const run = runner || ((cmd, args) =>
    execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, windowsHide: true }));
  try {
    if (process.platform === 'win32') {
      const out = run('tasklist', ['/FI', 'IMAGENAME eq dolt.exe', '/NH', '/FO', 'CSV']);
      // tasklist prints an "INFO: No tasks..." line (no CSV rows) when none match.
      return out.split(/\r?\n/).filter(l => /^"dolt\.exe"/i.test(l.trim())).length;
    }
    // POSIX: count exact-name dolt processes.
    const out = run('pgrep', ['-x', 'dolt']);
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).length;
  } catch (e) {
    // pgrep exits 1 with no output when there are zero matches — that's "0", not
    // a failure. Any stdout we got is the source of truth.
    const out = (e && e.stdout) ? String(e.stdout) : '';
    if (out) return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).length;
    if (e && e.status === 1) return 0; // pgrep "no matches"
    return -1; // genuinely unknown
  }
}

// Cached count: avoids enumerating processes on every single hook invocation.
function cachedCount() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (raw && typeof raw.count === 'number' && (Date.now() - raw.at) < CACHE_MS) return raw.count;
  } catch { /* no usable cache — fall through and recount */ }
  const count = countDoltProcesses();
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ count, at: Date.now() }));
  } catch (e) {
    // The cache is the only thing keeping this off a full process enumeration
    // on EVERY hook invocation; a failed write degrades that silently.
    require(path.join(__dirname, 'hook-logger.js'))
      .debug('dolt-guard', `could not write dolt-count cache: ${e && e.message}`);
  }
  return count;
}

// True when braynee should REFUSE to run anything that could start a dolt server.
// A counting failure (-1) returns false — we never block normal work just because
// we couldn't count; the cap is a backstop, not a gate on the happy path.
function overCap(count) {
  const n = (typeof count === 'number') ? count : cachedCount();
  return n >= CAP;
}

module.exports = { countDoltProcesses, cachedCount, overCap, CAP };
