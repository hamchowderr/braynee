#!/usr/bin/env node
// time-budget.test.js — cp-szoa. The module exists to stop a hook being killed
// mid-run, so the cases that matter are the boundaries: what happens as the
// budget runs out, and that a caller can tell it was truncated.
//
// Uses an injectable clock — a test that really slept would be slow and flaky,
// which is the exact problem this module was written to fix.

'use strict';

const { makeBudget, MIN_USEFUL_MS } = require('./time-budget.js');

let pass = 0, fail = 0;
const fails = [];
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; fails.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push(name); } }

// A clock we control: t is "now", advanced explicitly.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// ── a fresh budget hands out the full per-call cap ───────────────────────────
{
  const c = fakeClock();
  const b = makeBudget(12_000, { now: c.now });
  eq('remaining starts at the full budget', b.remaining(), 12_000);
  eq('a call under the budget gets its own cap', b.allow(8_000), 8_000);
  eq('nothing skipped yet', b.skipped, 0);
  eq('not exhausted', b.exhausted(), false);
}

// ── the cap is clamped to what is actually left ──────────────────────────────
{
  const c = fakeClock();
  const b = makeBudget(12_000, { now: c.now });
  c.advance(9_000);
  eq('remaining reflects elapsed time', b.remaining(), 3_000);
  eq('an 8s call is clamped to the 3s left', b.allow(8_000), 3_000);
  eq('a cap smaller than the remainder is untouched', b.allow(1_000), 1_000);
}

// ── once spent, calls are skipped rather than started ────────────────────────
{
  const c = fakeClock();
  const b = makeBudget(12_000, { now: c.now });
  c.advance(12_000);
  eq('remaining floors at zero, never negative', b.remaining(), 0);
  eq('a call with no budget left returns null', b.allow(8_000), null);
  eq('the skip is counted', b.skipped, 1);
  eq('further skips accumulate', (b.allow(8_000), b.skipped), 2);
  eq('exhausted is true', b.exhausted(), true);
}

// ── overrun does not produce negative timeouts ───────────────────────────────
{
  const c = fakeClock();
  const b = makeBudget(5_000, { now: c.now });
  c.advance(9_999);                       // well past the deadline
  eq('remaining is 0 past the deadline', b.remaining(), 0);
  eq('allow() is null past the deadline', b.allow(8_000), null);
}

// ── the MIN_USEFUL boundary ──────────────────────────────────────────────────
{
  const c = fakeClock();
  const b = makeBudget(10_000, { now: c.now });
  c.advance(10_000 - MIN_USEFUL_MS);      // exactly the minimum remains
  eq('exactly MIN_USEFUL is still usable', b.allow(5_000), MIN_USEFUL_MS);

  const c2 = fakeClock();
  const b2 = makeBudget(10_000, { now: c2.now });
  c2.advance(10_000 - MIN_USEFUL_MS + 1); // one ms below the minimum
  eq('one ms below MIN_USEFUL is skipped', b2.allow(5_000), null);
  eq('and counted as skipped', b2.skipped, 1);
}

// ── a configurable minimum ───────────────────────────────────────────────────
{
  const c = fakeClock();
  const b = makeBudget(10_000, { now: c.now, minUsefulMs: 2_000 });
  c.advance(8_500);                       // 1.5s left, under a 2s minimum
  eq('a custom minUsefulMs is honored', b.allow(5_000), null);
}

// ── realistic sequence: three 8s calls against a 12s budget ──────────────────
// This is stop-task-verify's actual shape and the reason the module exists.
{
  const c = fakeClock();
  const b = makeBudget(12_000, { now: c.now });
  const first = b.allow(8_000);
  eq('call 1 gets its full 8s', first, 8_000);
  c.advance(8_000);                       // it used all of it
  const second = b.allow(8_000);
  eq('call 2 is clamped to the 4s remaining', second, 4_000);
  c.advance(4_000);
  eq('call 3 is skipped, not started', b.allow(8_000), null);
  eq('exactly one call was skipped', b.skipped, 1);
  ok('total spend never exceeded the budget', first + second <= 12_000);
}

console.log(`time-budget.test.js: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exit(1); }
