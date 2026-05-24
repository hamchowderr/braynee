// Hook: TaskCompleted — fires when a task is marked complete.
// Complement to task-created-check.js. Part of the CC-tasks leg of the
// beads<->CC-todos<->TaskNotes mirror (cp-dw6).
//
// This hook CANNOT close the beads issue itself: there is no stable bd<->CC-task
// id map, so matching is fuzzy and an auto-`bd close` could close the wrong
// issue. Instead it surfaces a factual reminder so the assistant closes the
// matching issue on its next turn (beads remains the source of truth).
//
// cp-068/HD-4.1: a plain stdout write from a non-UserPromptSubmit hook is NOT
// added to Claude's context. The documented channel is
// hookSpecificOutput.additionalContext, and the text must be a FACTUAL
// statement (not an imperative) or it trips prompt-injection defenses and gets
// shown to the user instead of acted on. Mirrors beads-todo-reminder.js.
const path = require('path');
const { findCodeRoot, findBeadsRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

function emit(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'TaskCompleted', additionalContext: text },
  }));
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }
    const taskName = (data.task_name || data.task_subject || '').replace(/"/g, '\\"').slice(0, 140);

    // F-3.2a + F-3.2b: only act in a beads code context, detected
    // structurally on the SESSION's working dir — not a ~/code prefix.
    // findBeadsRoot excludes the global ~/.beads (bd init --shared-server).
    const codeRoot = findCodeRoot(sessionDir(data));
    if (!codeRoot) process.exit(0);
    if (!findBeadsRoot(codeRoot)) process.exit(0);

    emit(
      `The Claude Code task "${taskName}" was marked completed. ` +
      `beads is the source of truth: it is out of sync until the matching beads issue is closed ` +
      `(\`bd close <id> --reason "..."\`) and the TaskNote is marked complete. ` +
      `If no beads issue corresponds to this task, no close is needed.`
    );
  } catch {}
  process.exit(0);
});
