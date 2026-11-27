#!/usr/bin/env node
// dolthub-sync-core.test.js (cp-3tk). Pure helpers, plus one live parse of real
// `bd dolt remote list` output when bd is installed.
'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const c = require('./dolthub-sync-core.js');

assert.strictEqual(c.dolthubName('braynee'), 'braynee');
assert.strictEqual(c.dolthubName('my.site'), 'my-site');
assert.strictEqual(c.dolthubName('acme.dev'), 'acme-dev');
assert.strictEqual(c.dolthubName('...'), null);
assert.strictEqual(c.validOwner('acme'), true);
assert.strictEqual(c.validOwner(''), false);
assert.strictEqual(c.validOwner(undefined), false);
assert.strictEqual(c.validOwner('a/b'), false);
assert.strictEqual(c.remoteUrl('o', 'n'), 'https://doltremoteapi.dolthub.com/o/n');

assert.deepStrictEqual(c.parseRemotes('No remotes configured.\n'), []);
assert.deepStrictEqual(c.parseRemotes('origin               https://doltremoteapi.dolthub.com/acme/tracker\n'),
  [{ name: 'origin', url: 'https://doltremoteapi.dolthub.com/acme/tracker' }]);
assert.deepStrictEqual(c.dolthubTarget('https://doltremoteapi.dolthub.com/acme/tracker'), { owner: 'acme', name: 'tracker' });
assert.strictEqual(c.dolthubTarget('git+ssh://git@github.com/o/r.git'), null);
assert.strictEqual(c.dolthubTarget(null), null);

const url = c.remoteUrl('me', 'proj');
assert.strictEqual(c.planEnable({ origin: null, localOnly: false }, 'me', 'proj').action, 'wire');
assert.strictEqual(c.planEnable({ origin: url, localOnly: false }, 'me', 'proj').action, 'already');
assert.strictEqual(c.planEnable({ origin: 'git+ssh://git@github.com/o/r.git', localOnly: false }, 'me', 'proj').action, 'skip',
  'never overwrites an origin pointing elsewhere');
assert.strictEqual(c.planEnable({ origin: null, localOnly: true }, 'me', 'proj').action, 'skip', 'local-only wins');

assert.deepStrictEqual(c.createDatabaseBody('me', 'proj'),
  { ownerName: 'me', repoName: 'proj', visibility: 'private', description: 'beads issue tracker (bd), wired by braynee' });
assert.strictEqual(c.createDatabaseBody('me', 'proj', 'public').visibility, 'public');
assert.strictEqual(c.createDatabaseBody('me', 'proj', 'weird').visibility, 'private');

let live = 'skipped (no bd)';
if (spawnSync('bd', ['version']).status === 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braynee-dolthub-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  if (spawnSync('bd', ['init', '--prefix', 'tt', '-q'], { cwd: dir }).status === 0) {
    const list = () => spawnSync('bd', ['dolt', 'remote', 'list'], { cwd: dir, encoding: 'utf8' }).stdout;
    assert.deepStrictEqual(c.parseRemotes(list()), [], 'fresh repo: no remotes');
    spawnSync('bd', ['dolt', 'remote', 'add', 'origin', c.remoteUrl('someone', 'tt')], { cwd: dir });
    assert.deepStrictEqual(c.parseRemotes(list()), [{ name: 'origin', url: c.remoteUrl('someone', 'tt') }], 'real bd output parses');
    live = 'live bd remote list parsed';
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
console.log(`dolthub-sync-core.test: ok (${live})`);
