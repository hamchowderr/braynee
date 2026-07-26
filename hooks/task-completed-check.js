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
const map = require(path.join(__dirname, 'lib', 'bd-task-map.js')); // cp-ydy
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const HOOK = 'task-completed-check';

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
    // TaskCompleted carries a stable `task_id` (unlike TaskCreated). Extract it
    // and the title defensively across schema variants (docs: task_title/task_id).
    const rawTitle = data.task_title || data.task_name || data.task_subject || '';
    const taskName = rawTitle.replace(/"/g, '\\"').slice(0, 140);
    const taskId = data.task_id || data.task_uuid || data.id || null;

    // F-3.2a + F-3.2b: only act in a beads code context, detected
    // structurally on the SESSION's working dir — not a ~/code prefix.
    // findBeadsRoot excludes the global ~/.beads (bd init --shared-server).
    const codeRoot = findCodeRoot(sessionDir(data));
    if (!codeRoot) process.exit(0);
    const beadsRoot = findBeadsRoot(codeRoot);
    if (!beadsRoot) process.exit(0);

    // cp-ydy: this is the first sighting of the cc task id — bind it to the
    // title-keyed entry (recorded at `bd create`) and read back the exact
    // bd_id. A stable id beats fuzzy title matching: if the title was unique at
    // create time, this names the right issue to close, every time.
    let entry = null;
    try { entry = map.upsert(path.join(beadsRoot, '.beads'), { ccTaskId: taskId, title: rawTitle }); }
    catch (e) {
      // Without the entry there is no bd_id to name, so the hook falls back to
      // the generic "no beads issue is mapped" nudge — which looks like a
      // correct answer rather than a lookup that failed (cp-ydy).
      log.debug(HOOK, `task-map lookup failed: ${e && e.message}`);
    }

    if (entry && entry.bd_id) {
      emit(
        `The Claude Code task "${taskName}" (id ${taskId || '?'}) was marked completed. ` +
        `It maps to beads issue ${entry.bd_id} — if that issue is still open, close it ` +
        `(\`bd close ${entry.bd_id} --reason "..."\`) and mark the TaskNote complete. ` +
        `beads stays the source of truth.`
      );
    } else {
      emit(
        `The Claude Code task "${taskName}" was marked completed, but no beads issue is mapped to it. ` +
        `If a beads issue tracks this work, close it (\`bd close <id> --reason "..."\`) and mark the ` +
        `TaskNote complete; otherwise no close is needed.`
      );
    }
  } catch (e) {
    try { log.debug(HOOK, `unhandled: ${e && e.message}`); } catch { /* logging must never break the hook */ }
  }
  process.exit(0);
});
