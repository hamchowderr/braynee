#!/usr/bin/env node
'use strict';

// prd-seed-core.test.js — unit tests for the pure prd-seed logic (cp-9f2.3 dep
// edges, cp-9f2.4 DoD milestone). prd-seed creates beads from these, so a
// regression here would mis-order a backlog or drop the definition-of-done.

const assert = require('assert');
const {
  DOD_MILESTONE, itemKey, extractAnnotation,
  parseAcceptanceCriteria, buildDodItems, computeDependencyEdges,
} = require('./prd-seed-core.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── parseAcceptanceCriteria ──────────────────────────────────────────────────
const SAMPLE = `
# PRD

## Acceptance Criteria

### Milestone: MVP

- [ ] **[P0] Scaffold the app** — next.js + biome wired
- [ ] **[P1] Build the core feature** — the main flow works

### Milestone: Deploy

- [ ] **[P1] Deploy a preview** — vercel preview {after: build-the-core-feature}

## Risks
- nothing
`;

test('parseAcceptanceCriteria reads milestones, priority, title, description', () => {
  const items = parseAcceptanceCriteria(SAMPLE);
  assert.strictEqual(items.length, 3);
  assert.strictEqual(items[0].priority, 'P0');
  assert.strictEqual(items[0].title, 'Scaffold the app');
  assert.strictEqual(items[0].milestone, 'MVP');
  assert.strictEqual(items[1].milestone, 'MVP');
  assert.strictEqual(items[2].milestone, 'Deploy');
  assert.strictEqual(items[0].description, 'next.js + biome wired');
});

test('parseAcceptanceCriteria stops at the next ## section (no Risks bleed)', () => {
  const items = parseAcceptanceCriteria(SAMPLE);
  assert.ok(!items.some(i => /nothing/.test(i.description)));
});

test('parseAcceptanceCriteria parses an {after:} annotation and strips it from desc', () => {
  const items = parseAcceptanceCriteria(SAMPLE);
  const deploy = items.find(i => i.title === 'Deploy a preview');
  assert.deepStrictEqual(deploy.after, ['build-the-core-feature']);
  assert.strictEqual(deploy.description, 'vercel preview');
});

test('extractAnnotation supports the blocked-by alias and multiple refs', () => {
  const r = extractAnnotation('desc {blocked-by: a, Build The Thing}');
  assert.deepStrictEqual(r.after, ['a', 'build-the-thing']);
  assert.strictEqual(r.rest.trim(), 'desc');
});

test('itemKey slugifies titles deterministically', () => {
  assert.strictEqual(itemKey('Build the Core Feature!'), 'build-the-core-feature');
});

// ── buildDodItems (cp-9f2.4) ─────────────────────────────────────────────────
test('buildDodItems returns [] when the ship-pipeline rule is absent', () => {
  const items = buildDodItems({ shipPipelinePath: '/no/such/rule.md', exists: () => false });
  assert.strictEqual(items.length, 0);
});

test('buildDodItems returns the standard milestone when the rule exists', () => {
  const items = buildDodItems({ shipPipelinePath: '/rules/ship-pipeline.md', exists: () => true });
  assert.ok(items.length >= 5);
  assert.ok(items.every(i => i.milestone === DOD_MILESTONE));
  assert.ok(items.some(i => /biome/i.test(i.title)));
  assert.ok(items.some(i => /preview/i.test(i.title)));
  // head is gated (waits on the prior feature milestone); the rest chain.
  assert.strictEqual(items[0].gated, true);
});

// ── computeDependencyEdges (cp-9f2.3) ────────────────────────────────────────
test('computeDependencyEdges emits an after-annotation edge', () => {
  const items = parseAcceptanceCriteria(SAMPLE);
  const edges = computeDependencyEdges(items);
  assert.ok(edges.some(e =>
    e.fromTitle === 'Deploy a preview' &&
    e.toTitle === 'Build the core feature' &&
    e.reason === 'after-annotation'));
});

test('computeDependencyEdges gates a DoD-appended milestone behind the prior milestone', () => {
  const base = parseAcceptanceCriteria(SAMPLE);
  const dod = buildDodItems({ shipPipelinePath: 'x', exists: () => true });
  const edges = computeDependencyEdges([...base, ...dod]);
  // The gated DoD head depends on each item of the immediately-preceding (Deploy) milestone.
  const gate = edges.filter(e => e.reason === 'milestone-gate');
  assert.ok(gate.length >= 1);
  assert.ok(gate.every(e => e.toTitle === 'Deploy a preview'));
  // Intra-DoD chain (tier1 after biome) exists too.
  assert.ok(edges.some(e => e.reason === 'after-annotation' && /Tier-1/.test(e.fromTitle)));
});

test('computeDependencyEdges dedupes and never self-references', () => {
  const items = [
    { title: 'A', milestone: 'M', after: ['a'] },          // self-ref → dropped
    { title: 'B', milestone: 'M', after: ['a', 'a'] },     // dup → one edge
  ];
  const edges = computeDependencyEdges(items);
  assert.ok(!edges.some(e => e.fromTitle === e.toTitle));
  assert.strictEqual(edges.filter(e => e.fromTitle === 'B').length, 1);
});

// ── runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL: ${name}\n  ${err.message}`); failed++; }
}
console.log(`prd-seed-core: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
