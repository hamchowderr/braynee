#!/usr/bin/env node
// beads-status-sync.test.js
//
// The hook sees the command AFTER beads-actor-sign rewrote it, so every bd
// arrives as `bd --actor claude …`, often behind a `cd x;`. Both shapes must
// still register as a status change, or beads-active-issue.json is never written.
//
// Pure Node, no deps, cross-platform. Exit 0 = pass, 1 = fail.

'use strict';

const { parseStatusChange } = require('./beads-status-sync.js');

let pass = 0, fail = 0;
const fails = [];
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; fails.push(`${name}\n    got:  ${g}\n    want: ${w}`); }
}

eq('plain claim', parseStatusChange('bd update a-1 --claim'), { issueId: 'a-1', newStatus: 'in_progress' });
eq('signed claim', parseStatusChange('bd --actor claude update a-1 --claim'), { issueId: 'a-1', newStatus: 'in_progress' });
eq('subagent actor', parseStatusChange('bd --actor claude/general-purpose update a-1 --claim'), { issueId: 'a-1', newStatus: 'in_progress' });
eq('actor=', parseStatusChange('bd --actor=claude close a-1 --reason x'), { issueId: 'a-1', newStatus: 'closed' });
eq('after cd (bash)', parseStatusChange('cd /repo && bd --actor claude update a-1 --status in_progress'), { issueId: 'a-1', newStatus: 'in_progress' });
eq('after cd (ps)', parseStatusChange('cd C:\\repo; bd --actor claude update s-4s5.1 --claim'), { issueId: 's-4s5.1', newStatus: 'in_progress' });
eq('status=', parseStatusChange('bd --actor claude update a-1 --status=blocked'), { issueId: 'a-1', newStatus: 'blocked' });
eq('signed close', parseStatusChange('bd --actor claude close a-1 a-2'), { issueId: 'a-1', newStatus: 'closed' });
eq('-C dir', parseStatusChange('bd -C ../x --actor claude close a-1'), { issueId: 'a-1', newStatus: 'closed' });
eq('show is not a change', parseStatusChange('bd --actor claude show a-1'), null);
eq('title edit is not a change', parseStatusChange('bd --actor claude update a-1 --title "x"'), null);
eq('quoted bd is data', parseStatusChange('echo "bd close a-1"'), null);
eq('empty', parseStatusChange(''), null);

console.log(`beads-status-sync: ${pass} passed, ${fail} failed`);
if (fail) { console.log(fails.join('\n')); process.exit(1); }
