#!/usr/bin/env node
'use strict';

// prd-seed-gate.test.js — unit tests for the pure helpers behind the prd-seed gate
// (cp-7jd). The warn/clean decision is driven by these, so a regression would either
// nag on every seed or let a half-scoped PRD seed silently.

const assert = require('assert');
const { parsePrdSeedCommand, sectionBody, findPrdGaps } = require('./prd-seed-gate.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── parsePrdSeedCommand ──────────────────────────────────────────────────────
test('detects a quoted PRD name after a quoted script path', () => {
  const p = parsePrdSeedCommand('node "C:/x/scripts/prd-seed.mjs" "My App"');
  assert.deepStrictEqual(p, { name: 'My App' });
});

test('detects a bare PRD name with trailing flags', () => {
  const p = parsePrdSeedCommand('node prd-seed.mjs DealReveal --dry-run');
  assert.deepStrictEqual(p, { name: 'DealReveal' });
});

test('returns null for flags-only (no name)', () => {
  assert.strictEqual(parsePrdSeedCommand('node prd-seed.mjs --dry-run'), null);
});

test('returns null for non-prd-seed commands', () => {
  assert.strictEqual(parsePrdSeedCommand('bd ready'), null);
  assert.strictEqual(parsePrdSeedCommand('git push origin main'), null);
});

test('does NOT match sibling scripts (prd-seed-core.js / prd-seed-gate.js)', () => {
  assert.strictEqual(parsePrdSeedCommand('node hooks/prd-seed-gate.js'), null);
  assert.strictEqual(parsePrdSeedCommand('node scripts/lib/prd-seed-core.js'), null);
});

// ── sectionBody ──────────────────────────────────────────────────────────────
test('sectionBody extracts a heading body up to the next ## ', () => {
  const md = '## MVP Definition\nAuth: Clerk\n\n## Scope\nin scope';
  assert.strictEqual(sectionBody(md, 'MVP Definition').trim(), 'Auth: Clerk');
  assert.strictEqual(sectionBody(md, 'Nope'), '');
});

// ── findPrdGaps ──────────────────────────────────────────────────────────────
const SCAFFOLD = `## MVP Definition

### Auth

<approach (Clerk / Supabase / custom), SSO needs, org/team support>

### Freemium

<free tier limits, paid tier pricing>

### Core Features (3–5)

1. ...
2. ...
3. ...

## Risks & Open Questions

- **Risk:** …
- **Open question:** …
`;

const FILLED = `## MVP Definition

### Auth

Clerk with org/team support; no SSO at MVP.

### Freemium

Free: 3 reports/mo. Paid: $19/mo unlimited. Paywall after the 3rd report.

### Core Features (3–5)

1. Scoring engine
2. WordPress shortcode
3. Stripe checkout

## Risks & Open Questions

- **Risk:** Stripe webhook reliability under load.
`;

test('scaffold PRD reports MVP placeholders (angle + ellipsis lines)', () => {
  const g = findPrdGaps(SCAFFOLD);
  assert.ok(g.mvpPlaceholders >= 5, 'expected >=5 placeholders, got ' + g.mvpPlaceholders);
});

test('scaffold PRD does NOT count the placeholder open-question bullet', () => {
  // "- **Open question:** …" is an empty placeholder, not a real unresolved question
  assert.strictEqual(findPrdGaps(SCAFFOLD).openQuestions, 0);
});

test('a real open-question bullet IS counted', () => {
  const md = SCAFFOLD + '\n- **Open question:** Do we need multi-currency at MVP?\n';
  assert.strictEqual(findPrdGaps(md).openQuestions, 1);
});

test('a fully-filled PRD is clean (0 / 0) — no gate friction', () => {
  const g = findPrdGaps(FILLED);
  assert.deepStrictEqual(g, { mvpPlaceholders: 0, openQuestions: 0 });
});

test('a PRD with no MVP Definition section flags as incomplete', () => {
  assert.ok(findPrdGaps('## Scope\nstuff').mvpPlaceholders >= 1);
});

// ── runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL: ${name}\n  ${err.message}`); failed++; }
}
console.log(`prd-seed-gate: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
