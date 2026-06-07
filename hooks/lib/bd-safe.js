// bd-safe.js
// Single guarded entry point for running `bd` from braynee hooks.
//
// braynee hooks should NEVER call `bd` directly with raw execSync/spawn, because
// when the Dolt server is wedged or a project is in per-project mode, bd can
// auto-start a new dolt sql-server — and many hooks doing that on every tool use
// is how the machine floods. This wrapper consults the hard cap (dolt-guard)
// first: once the machine is at/over the dolt-server cap, braynee refuses to run
// bd at all, so it can never *add* to a runaway. Otherwise it runs bd normally.
//
// Returns { ok, out, err, skipped } — `skipped` is set (and ok=false) when the
// cap tripped, so callers can stay silent rather than treating it as an error.

'use strict';

const { execSync } = require('child_process');
const { overCap, cachedCount, CAP } = require(require('path').join(__dirname, 'dolt-guard.js'));

// Run a full `bd ...` command string (matches the existing hooks' `run()` shape).
function runBdSafe(cmd, opts = {}) {
  if (overCap()) {
    return {
      ok: false,
      skipped: 'over-cap',
      out: '',
      err: `braynee: skipped "${cmd}" — ${cachedCount()} dolt servers already running (cap ${CAP}). ` +
           `Refusing to risk starting another. Clear orphans / fix the wedged server first.`,
    };
  }
  try {
    const out = execSync(cmd, {
      encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, ...opts,
    });
    return { ok: true, out: (out || '').toString().trim(), err: '', skipped: null };
  } catch (e) {
    return {
      ok: false,
      out: e.stdout ? e.stdout.toString() : '',
      err: e.stderr ? e.stderr.toString() : (e.message || ''),
      skipped: null,
    };
  }
}

// Convenience: returns trimmed stdout or '' (never throws, never floods).
// Drop-in for hooks whose local `run(cmd)` returned stdout-or-null/''.
function bdOut(cmd, opts = {}) {
  const r = runBdSafe(cmd, opts);
  return r.ok ? r.out : '';
}

module.exports = { runBdSafe, bdOut };
