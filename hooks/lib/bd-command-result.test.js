#!/usr/bin/env node
// bd-command-result.test.js — cp-snh2.
//
// Two defects that both attached mirror state to something that never happened:
//
//   1. Every bd-id capture used ([\w-]+), and \w excludes `.`, so every dotted
//      sub-issue id truncated to its PARENT: cp-uif3.3 -> cp-uif3. In
//      beads-status-sync that id drives the vault TaskNotes mirror, so closing a
//      SUBTASK marked the parent EPIC's note complete. 50 of 247 issues in this
//      repo (20%) carry a dotted id.
//   2. The hooks fired on the command TEXT without checking whether it
//      succeeded. Observed live: `bd close cp-uif3.3 --reason="" --dry-run`
//      (invalid flag, non-zero exit, nothing closed) still emitted "beads issue
//      cp-uif3 is now closed" — wrong on both counts at once.
//
// Behavioral: drives the real hooks over stdin, since the whole class of bug is
// about what the hook DOES with a payload, not how its regex reads.
//
// Pure Node, no deps, cross-platform. Exit 0 = pass, 1 = fail.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { bdOutcome, bdSucceeded } = require('./bd-command-result.js');

let pass = 0, fail = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : '')); }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const HOOKS = path.join(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'snh2-'));

try {
  const repo = path.join(sandbox, 'proj');
  fs.mkdirSync(path.join(repo, '.beads'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.beads', 'issues.jsonl'), '');

  // ── 1. outcome classification ─────────────────────────────────────────────
  eq('a numeric zero exit is success', bdOutcome({ tool_response: { exit_code: 0 } }), 'success');
  eq('a numeric non-zero exit is failure', bdOutcome({ tool_response: { exit_code: 1 } }), 'failure');
  eq('bd\'s success marker is recognized',
     bdOutcome({ tool_response: { stdout: '✓ Closed cp-abc — title: done' } }), 'success');
  eq('an Error: line is failure',
     bdOutcome({ tool_response: { stderr: 'Error: unknown flag --dry-run' } }), 'failure');
  eq('a Usage: line is failure',
     bdOutcome({ tool_response: { stdout: 'Usage: bd close <id>' } }), 'failure');
  eq('no tool_response at all is unknown', bdOutcome({}), 'unknown');
  eq('empty output is unknown', bdOutcome({ tool_response: { stdout: '   ' } }), 'unknown');

  // The tie-break that matters: bd prints benign warnings to stderr alongside a
  // SUCCESSFUL mutation (the auto-export shrink guard fires constantly here).
  // Treating that as failure would suppress real events and deepen cp-na6c.
  eq('success beats a benign stderr warning',
     bdOutcome({ tool_response: {
       stdout: '✓ Closed cp-abc — title',
       stderr: 'Warning: auto-export failed: auto-export shrink guard: refusing to overwrite',
     } }), 'success');
  ok('unknown is treated as "act" — never silently drop a real event',
     bdSucceeded({}) === true && bdSucceeded({ tool_response: { stdout: '' } }) === true);
  ok('only visible failure suppresses',
     bdSucceeded({ tool_response: { exit_code: 2 } }) === false);

  // ── 2. dotted ids round-trip through the real hooks ───────────────────────
  const fire = (hook, payload) => {
    const r = spawnSync(process.execPath, [path.join(HOOKS, hook)], {
      input: JSON.stringify(payload),
      encoding: 'utf8', timeout: 30000, windowsHide: true, cwd: repo,
      env: { ...process.env, BRAYNEE_HOOK_LOG: path.join(sandbox, 'hook.log') },
    });
    return (r.stdout || '') + (r.stderr || '');
  };
  const okPayload = (cmd) => ({
    cwd: repo, tool_name: 'Bash', tool_input: { command: cmd },
    tool_response: { stdout: '✓ Closed cp-x — t', exit_code: 0 },
  });

  for (const id of ['cp-uif3.3', 'cp-lj73.2', 'cp-ccsh.11']) {
    const out = fire('beads-todo-reminder.js', okPayload(`bd close ${id}`));
    ok(`a dotted id survives intact in the reminder (${id})`,
       out.includes(id), out.slice(0, 200));
    // The parent id is a PREFIX of the dotted id, so a naive "does it contain
    // the parent" check passes either way. Assert the truncated form does not
    // appear as the WHOLE id — that is the actual regression.
    const parent = id.split('.')[0];
    ok(`...and is not truncated to the parent (${parent})`,
       !new RegExp(`issue ${parent.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')} is now`).test(out),
       out.slice(0, 200));
  }
  {
    const out = fire('beads-todo-reminder.js', okPayload('bd update cp-uif3.1 --claim'));
    ok('a dotted id survives a --claim', out.includes('cp-uif3.1'), out.slice(0, 200));
  }
  {
    const out = fire('beads-todo-reminder.js', okPayload('bd close cp-fs2'));
    ok('an undotted id still works', out.includes('cp-fs2'), out.slice(0, 200));
  }

  // ── 3. a FAILED bd command emits nothing ──────────────────────────────────
  // The exact command that exposed this, verbatim.
  {
    const failed = {
      cwd: repo, tool_name: 'Bash',
      tool_input: { command: 'bd close cp-uif3.3 --reason="" --dry-run' },
      tool_response: { stdout: '', stderr: 'Error: unknown flag: --dry-run', exit_code: 1 },
    };
    const out = fire('beads-todo-reminder.js', failed);
    ok('a FAILED bd close emits no reminder', !/is now closed/.test(out), out.slice(0, 200));
    ok('...and does not name any issue', !/cp-uif3/.test(out), out.slice(0, 200));

    const sync = fire('beads-status-sync.js', failed);
    ok('a FAILED bd close writes no mirror output', !/is now closed/.test(sync), sync.slice(0, 200));
  }
  {
    // The inverse, so section 3 cannot pass just because the hook is broken.
    const out = fire('beads-todo-reminder.js', okPayload('bd close cp-uif3.3'));
    ok('a SUCCEEDING bd close still emits', /is now closed/.test(out), out.slice(0, 200));
  }
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

if (fail === 0) {
  console.log(`bd-command-result.test.js: ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`bd-command-result.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
