// task-created-check.js
// Hook: TaskCreated — Blocks task creation if Beads isn't initialized
// Checks for .beads/ directory in the project root (created by `bd init`)
// Exit 0 = allow creation, Exit 2 = block with feedback to model
// Only applies to projects in the code directory (not workspace or other dirs)

const path = require('path');
const { findCodeRoot, findBeadsRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));
const map = require(path.join(__dirname, 'lib', 'bd-task-map.js')); // cp-ydy
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const HOOK = 'task-created-check';

// cp-068/HD-4.1: non-UserPromptSubmit stdout doesn't reach Claude unless sent
// via hookSpecificOutput.additionalContext as a FACTUAL statement. Used on the
// ALLOW path only — the BLOCK path stays stderr + exit 2 (enforcement). See
// beads-todo-reminder.js for the same pattern.
function emit(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'TaskCreated', additionalContext: text },
  }));
}

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
    const beadsRoot = findBeadsRoot(codeRoot);

    if (!beadsRoot) {
      process.stderr.write(
        `BLOCKED: Beads is not initialized in this project. ` +
        `Run \`bd init\` in the project root before creating tasks with TaskCreate. ` +
        `Task subject was: "${data.task_title || data.task_subject || '(unknown)'}"`
      );
      process.exit(2);
    }

    // Allow path: beads is initialized. Surface a factual reminder so the
    // CC-task <-> beads mirror stays consistent. Not an auto-create — without a
    // stable id map that would duplicate the issue when the task was already
    // mirrored from a `bd create` (the normal flow). beads stays source of truth.
    const subject = (data.task_title || data.task_subject || data.task_name || '').replace(/"/g, '\\"').slice(0, 140);
    // cp-ydy: ensure a map entry keyed by title. TaskCreated carries no stable
    // task id (assigned after the hook fires), so we can only seed the title
    // here — TaskCompleted binds the cc_task_id to it later. If `bd create`
    // already recorded a bd_id under this title, this is a no-op merge.
    try { map.upsert(path.join(beadsRoot, '.beads'), { title: subject }); }
    catch (e) {
      // Seeds the title key that TaskCompleted later binds a cc_task_id to.
      // Losing it here means the completion hook finds no mapping (cp-ydy).
      log.debug(HOOK, `could not seed task-map title: ${e && e.message}`);
    }
    emit(
      `A Claude Code task "${subject}" was created. ` +
      `beads is the source of truth: it is out of sync unless a beads issue tracks this work. ` +
      `If this task was mirrored from an existing \`bd create\`, no action is needed; ` +
      `otherwise create the matching beads issue (\`bd create ...\`).`
    );
    process.exit(0);
  } catch {
    // Don't block on errors
    process.exit(0);
  }
});
