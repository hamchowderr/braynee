#!/usr/bin/env node
// bd-json.test.js (cp-uif3.6) — both of bd's JSON shapes read the same.
// The last block runs the installed bd with and without BD_JSON_ENVELOPE=1 and
// checks the two parse identically; it is skipped where bd is missing.
'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isEnvelope, unwrap, parse, parseOr, parseList } = require('./bd-json.js');

const issues = [{ id: 'tt-1', title: 'a' }];
assert.deepStrictEqual(parse(JSON.stringify(issues)), issues, 'legacy list');
assert.deepStrictEqual(parse(JSON.stringify({ data: issues, schema_version: 1 })), issues, 'envelope list');
assert.deepStrictEqual(parse('{"data":{"summary":{"total_issues":3}},"schema_version":1}'), { summary: { total_issues: 3 } }, 'envelope object');
assert.deepStrictEqual(parse('{"summary":{"total_issues":3}}'), { summary: { total_issues: 3 } }, 'legacy object');
// A legacy object that happens to carry `data` is not an envelope.
assert.deepStrictEqual(unwrap({ data: 1, other: 2 }), { data: 1, other: 2 }, 'data without schema_version');
assert.strictEqual(isEnvelope([]), false);
assert.strictEqual(isEnvelope(null), false);
assert.throws(() => parse('not json'));
assert.strictEqual(parseOr('not json', 'fb'), 'fb');
assert.deepStrictEqual(parseList('{"error":"x"}'), [], 'non-list is []');
assert.deepStrictEqual(parseList('{"data":[{"id":"x"}],"schema_version":1}'), [{ id: 'x' }]);
assert.deepStrictEqual(parseList(''), []);

let live = 'skipped (no bd)';
if (spawnSync('bd', ['version'], { encoding: 'utf8' }).status === 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braynee-bdjson-'));
  const run = (args, env = {}) => spawnSync('bd', args, {
    cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, BD_JSON_ENVELOPE: '', ...env },
  });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const init = run(['init', '--prefix', 'tt', '-q']);
  if (init.status === 0 && run(['create', 'one', '-t', 'task']).status === 0) {
    for (const cmd of [['list', '--json'], ['ready', '--json']]) {
      const legacy = parseList(run(cmd).stdout);
      const env = parseList(run(cmd, { BD_JSON_ENVELOPE: '1' }).stdout);
      assert.strictEqual(legacy.length, 1, `${cmd[0]} legacy has the issue`);
      assert.deepStrictEqual(env.map(i => i.id), legacy.map(i => i.id), `${cmd[0]} envelope == legacy`);
    }
    const s1 = parse(run(['stats', '--json']).stdout);
    const s2 = parse(run(['stats', '--json'], { BD_JSON_ENVELOPE: '1' }).stdout);
    assert.strictEqual(s1.summary.total_issues, s2.summary.total_issues, 'stats envelope == legacy');
    live = 'live bd: list, ready, stats agree in both shapes';
  } else {
    live = 'skipped (bd init failed)';
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
console.log(`bd-json.test: ok (${live})`);
