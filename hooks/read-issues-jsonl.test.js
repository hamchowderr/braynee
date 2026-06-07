'use strict';
// Unit tests for lib/read-issues-jsonl.js — the server-free, repo-scoped beads
// reader that replaced `bd list`/`bd stale` in the routine read hooks (cp-6j5).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readIssues, isOpen, staleOpen } = require('./lib/read-issues-jsonl.js');

function tmpRepo(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braynee-rij-'));
  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.beads', 'issues.jsonl'), lines.join('\n'));
  return dir;
}

test('readIssues: keeps issue records, skips blanks / bad JSON / non-issue rows', () => {
  const dir = tmpRepo([
    JSON.stringify({ _type: 'issue', id: 'x-1', status: 'open', title: 'A' }),
    '',
    'not json at all',
    JSON.stringify({ _type: 'dependency', issue_id: 'x-1' }), // non-issue row
    JSON.stringify({ id: 'x-2', status: 'closed', title: 'B' }), // no _type but has id
    JSON.stringify({ _type: 'issue', title: 'no id' }), // missing id -> skipped
  ]);
  assert.deepStrictEqual(readIssues(dir).map((i) => i.id).sort(), ['x-1', 'x-2']);
});

test('readIssues: missing file -> []', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braynee-rij-empty-'));
  assert.deepStrictEqual(readIssues(dir), []);
});

test('isOpen: anything not closed counts as open', () => {
  assert.strictEqual(isOpen({ status: 'open' }), true);
  assert.strictEqual(isOpen({ status: 'in_progress' }), true);
  assert.strictEqual(isOpen({ status: 'blocked' }), true);
  assert.strictEqual(isOpen({ status: 'closed' }), false);
  assert.strictEqual(isOpen({}), false);
  assert.strictEqual(isOpen(null), false);
});

test('staleOpen: open + older than N days; excludes recent and closed', () => {
  const now = Date.parse('2026-06-07T12:00:00Z');
  const issues = [
    { id: 'old', status: 'open', updated_at: '2026-01-01T00:00:00Z' },
    { id: 'recent', status: 'open', updated_at: '2026-06-07T00:00:00Z' },
    { id: 'closed-old', status: 'closed', updated_at: '2026-01-01T00:00:00Z' },
    { id: 'no-date', status: 'open' },
  ];
  assert.deepStrictEqual(staleOpen(issues, 14, now).map((i) => i.id), ['old']);
});

test('staleOpen: falls back to created_at when updated_at absent', () => {
  const now = Date.parse('2026-06-07T12:00:00Z');
  const issues = [{ id: 'c', status: 'open', created_at: '2026-01-01T00:00:00Z' }];
  assert.deepStrictEqual(staleOpen(issues, 14, now).map((i) => i.id), ['c']);
});
