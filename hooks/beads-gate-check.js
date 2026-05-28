// beads-gate-check.js
// Hook: Stop — auto-advances beads async gates so poured molecules flow on
// their own. Each turn-end, if the project's beads has any OPEN gates, run
// `bd gate check` to resolve any whose external condition is now met
// (gh:run/gh:pr completed, timer elapsed, bead closed). Resolving a gate
// unblocks its downstream step on the next `bd ready`.
//
// Never hard-blocks (exit 0 always). Cheap: the `bd gate list` pre-check means
// `bd gate check` (which may poll GitHub) only runs when gates actually exist.
// Gates on the SESSION's beads root (anchored at SessionStart), detected
// structurally — mirrors beads-stop-check.js so a pure vault session never
// touches global beads state. cp-mls.

const { execSync } = require('child_process');
const path = require('path');
const { findCodeRoot, findBeadsRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

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

    // Cheap pre-check: only spend the (possibly network-bound) `gate check`
    // when this repo actually has open gates.
    const list = run('bd gate list', { cwd });
    if (!list || /no open gates/i.test(list) || !/gate/i.test(list)) process.exit(0);

    // Evaluate gates: closes any whose await condition is now met.
    const before = list;
    run('bd gate check', { cwd, timeout: 30000 });
    const after = run('bd gate list', { cwd });

    // If the open-gate set shrank, some gate(s) resolved — tell Claude so it
    // can pick up newly-unblocked work. Factual statement (not an imperative).
    const countOpen = (s) => s ? (s.match(/timeout:/g) || []).length : 0;
    const resolved = countOpen(before) - countOpen(after);
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
