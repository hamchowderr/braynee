// beads-gate-check.js
// Hook: Stop — auto-advances beads async gates so poured molecules flow on
// their own. Each turn-end, if the project's beads has any OPEN gates, run
// `bd gate discover` (fills gh:run await_ids by branch/SHA/time) then
// `bd gate check` to resolve any whose external condition is now met
// (gh:run/gh:pr completed, timer elapsed, bead closed). Resolving a gate
// unblocks its downstream step on the next `bd ready` — this is the resume path
// for the autonomous-ship drain (a merged PR unblocks `ship` with no manual
// gate commands).
//
// Never hard-blocks (exit 0 always). Cheap: the `bd gate list` pre-check means
// the (possibly network-bound) discover/check only run when gates actually exist.
// Gates on the SESSION's beads root (anchored at SessionStart), detected
// structurally — mirrors beads-stop-check.js so a pure vault session never
// touches global beads state. cp-mls / cp-8d9.

const { execSync } = require('child_process');
const path = require('path');
const { findCodeRoot, findBeadsRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

// ── Pure helpers (exported for the unit test) ────────────────────────────────

// Count open gates in `bd gate list` output. Each open-gate line carries a
// `timeout:` field, so that's the structural marker we count.
function countOpenGates(s) {
  return s ? (s.match(/timeout:/g) || []).length : 0;
}

// Pre-check: is it worth spending the network-bound discover/check? True only
// when the list is non-empty, isn't the "no open gates" sentinel, and mentions a gate.
function hasOpenGates(list) {
  return !!list && !/no open gates/i.test(list) && /gate/i.test(list);
}

// How many gates resolved between two `bd gate list` snapshots (clamped ≥ 0).
function gatesResolved(before, after) {
  return Math.max(0, countOpenGates(before) - countOpenGates(after));
}

module.exports = { countOpenGates, hasOpenGates, gatesResolved };

// ── Hook body (only when run directly) ───────────────────────────────────────
if (require.main === module) {
  function run(cmd, opts = {}) {
    try {
      return execSync(cmd, { encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, ...opts }).trim();
    } catch { return null; }
  }

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      let data = {};
      if (input) { try { data = JSON.parse(input); } catch { data = {}; } }

      const codeRoot = findCodeRoot(sessionDir(data));
      if (!codeRoot) process.exit(0);
      const beadsRoot = findBeadsRoot(codeRoot); // excludes global ~/.beads
      if (!beadsRoot) process.exit(0);
      const cwd = beadsRoot;

      // Cheap pre-check: only spend discover/check when this repo has open gates.
      const before = run('bd gate list', { cwd });
      if (!hasOpenGates(before)) process.exit(0);

      // Discover gh:run run IDs (by branch/SHA/time), then evaluate all gates:
      // closes any whose await condition is now met. discover is best-effort.
      run('bd gate discover', { cwd, timeout: 30000 });
      run('bd gate check', { cwd, timeout: 30000 });
      const after = run('bd gate list', { cwd });

      // If the open-gate set shrank, some gate(s) resolved — tell Claude so it
      // can pick up newly-unblocked work. Factual statement (not an imperative).
      const resolved = gatesResolved(before, after);
      if (resolved > 0) {
        process.stdout.write(
          `## Beads gates advanced\n` +
          `${resolved} async gate(s) resolved this turn — newly-unblocked work may be available. ` +
          `Run \`bd ready\` to see the current front.`
        );
      }
      process.exit(0);
    } catch {
      process.exit(0);
    }
  });
}
