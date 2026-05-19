// task-created-check.js
// Hook: TaskCreated — Blocks task creation if Beads isn't initialized
// Checks for .beads/ directory in the project root (created by `bd init`)
// Exit 0 = allow creation, Exit 2 = block with feedback to model
// Only applies to projects in the code directory (not workspace or other dirs)

const path = require('path');
const { findCodeRoot, findBeadsRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    // Guard the parse: this is an exit-2 ENFORCEMENT guard — a malformed
    // payload must not be the thing that silently disables it. {} fallback
    // means an undetectable session is treated as "not a code context" and
    // the guard no-ops (fail-open is correct for an advisory block here).
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }

    // F-3.2a + F-3.2b: only enforce for code projects, detected structurally
    // on the SESSION's working dir (anchored at SessionStart) — not a
    // hardcoded ~/code prefix on the transient cwd. Before this fix the
    // enforcement was silently disabled for every project outside ~/code.
    const codeRoot = findCodeRoot(sessionDir(data));
    if (!codeRoot) {
      process.exit(0);
    }
    if (path.basename(codeRoot).toLowerCase() === 'workspace') {
      process.exit(0);
    }

    // .beads/ from the code root, EXCLUDING the global ~/.beads that
    // `bd init --shared-server` creates — otherwise every project would look
    // beads-initialized and this enforcement guard would never fire.
    const beadsFound = findBeadsRoot(codeRoot) !== null;

    if (!beadsFound) {
      process.stderr.write(
        `BLOCKED: Beads is not initialized in this project. ` +
        `Run \`bd init\` in the project root before creating tasks with TaskCreate. ` +
        `Task subject was: "${data.task_subject || '(unknown)'}"`
      );
      process.exit(2);
    }

    process.exit(0);
  } catch {
    // Don't block on errors
    process.exit(0);
  }
});
