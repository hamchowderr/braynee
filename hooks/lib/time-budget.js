'use strict';

// time-budget.js — one wall-clock budget for a hook that shells out repeatedly.
// cp-szoa.
//
// Why this exists: a Claude Code hook gets a single timeout from hooks.json, but
// hooks here call `bd`/`mtn`/`git` several times in sequence, each with its OWN
// generous per-call timeout. Those per-call caps sum to far more than the hook is
// allowed, so a couple of slow calls get the whole hook killed mid-run — and a
// killed hook emits NOTHING, with no trace beyond the process dying. Measured
// worst cases against their budgets when this module was written:
//
//   stop-task-verify   3 calls x 8s  = 24s   vs 15s
//   beads-gate-check   4 calls, 2 at 30s = 100s vs 15s
//   beads-close-gate   N ids x 15s          vs 10s
//
// The fix is not "raise the timeouts" — that hides a genuinely slow CLI. It is to
// spend a single budget down across calls, so a slow call costs the LATER checks
// rather than the entire hook. Partial output beats being killed with none.
//
// ONLY for hooks whose work is safe to truncate — checks, gates, read-only
// queries. A hook doing MUTATING work (bd init, bd hooks install, server heal)
// must not be cut short half-way; those need a larger hooks.json timeout instead.

// Leave room for node boot + stdin read before the budget starts being spent.
const DEFAULT_HEADROOM_MS = 3_000;

// Below this there is no point starting another call — it would be killed
// almost immediately and just burn the remainder.
const MIN_USEFUL_MS = 750;

function makeBudget(totalMs, opts = {}) {
  const minUseful = opts.minUsefulMs == null ? MIN_USEFUL_MS : opts.minUsefulMs;
  const now = opts.now || Date.now;
  const deadline = now() + totalMs;
  let skipped = 0;

  return {
    totalMs,
    // Milliseconds left, never negative.
    remaining() {
      return Math.max(0, deadline - now());
    },
    // The timeout to hand this call: its own cap, clamped to what is left.
    // Returns null when there is not enough left to be worth starting, and
    // counts that as skipped.
    allow(capMs) {
      const left = Math.max(0, deadline - now());
      if (left < minUseful) { skipped++; return null; }
      return Math.min(capMs, left);
    },
    // How many calls were skipped because the budget ran out. A caller that
    // reports "all clear" without checking this is lying about its coverage.
    get skipped() { return skipped; },
    exhausted() {
      return Math.max(0, deadline - now()) < minUseful;
    },
  };
}

module.exports = { makeBudget, DEFAULT_HEADROOM_MS, MIN_USEFUL_MS };
