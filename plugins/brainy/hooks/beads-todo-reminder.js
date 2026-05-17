// beads-todo-reminder.js
// Hook: PostToolUse (Bash, sync) — emits a <system-reminder> after bd
// state-change commands telling the assistant to mirror the change to the
// Claude Code todo list (TodoWrite).
//
// Three-way task mirror:
//   beads     = source of truth (agent reads + writes)
//   TodoWrite = live terminal view (user verifies in real time)
//   TaskNotes = vault audit trail (auto-synced by beads-status-sync.js)
//
// TodoWrite is an assistant-only tool — hooks cannot call it directly. So
// this hook surfaces a reminder on the matching tool result. The assistant
// is expected (per CLAUDE.md) to call TodoWrite on its next turn.

const fs = require('fs');
const path = require('path');

// cp-psc / HD-4.1 + HD-R2.2: PostToolUse stdout is NOT added to Claude's
// context — only UserPromptSubmit/UserPromptExpansion/SessionStart stdout is.
// The documented channel for PostToolUse is hookSpecificOutput.additionalContext
// (Hooks reference, "Add context for Claude"). Separately, the text must be a
// FACTUAL statement, not an imperative "do X NOW" wrapped in a fake
// <system-reminder> tag: per the reference, out-of-band command phrasing trips
// Claude's prompt-injection defenses and gets surfaced to the user instead of
// acted on — the likely real cause of the missing TodoWrite/TaskNotes mirror.
function emit(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: text,
    },
  }));
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const cmd = (data.tool_input?.command || '').trim();
    const cwd = data.cwd || process.cwd();

    // Only fire for beads-initialized projects.
    if (!fs.existsSync(path.join(cwd, '.beads'))) process.exit(0);

    // ─── bd create ────────────────────────────────────────────────
    if (/^bd\s+create\s/.test(cmd)) {
      const stdout = data.tool_response?.stdout || data.tool_response?.output || '';
      const idMatch = stdout.match(/Created\s+issue:?\s*([A-Za-z][\w-]+)/i)
                   || stdout.match(/\b(bd-[\w-]+)\b/);
      // Title can be in the stdout after the dash OR pulled from the command.
      let title = '';
      const stdoutTitleMatch = stdout.match(/Created\s+issue:?\s*[\w-]+\s*[—:\-]\s*(.+?)(?:\n|$)/i);
      if (stdoutTitleMatch) title = stdoutTitleMatch[1].trim();
      if (!title) {
        const flagDouble = cmd.match(/--title\s*=\s*"([^"]+)"/);
        const flagSingle = cmd.match(/--title\s*=\s*'([^']+)'/);
        const flagSpaceDouble = cmd.match(/--title\s+"([^"]+)"/);
        const flagSpaceSingle = cmd.match(/--title\s+'([^']+)'/);
        const posArg = cmd.match(/bd\s+create\s+(?:"([^"]+)"|'([^']+)')/);
        title = (flagDouble && flagDouble[1])
             || (flagSingle && flagSingle[1])
             || (flagSpaceDouble && flagSpaceDouble[1])
             || (flagSpaceSingle && flagSpaceSingle[1])
             || (posArg && (posArg[1] || posArg[2]))
             || '';
      }
      title = title.replace(/"/g, '\\"').slice(0, 140);

      if (idMatch) {
        emit(
          `beads issue ${idMatch[1]} was created ("${title}"). ` +
          `The Claude Code todo list and the TaskNotes vault mirror are out of sync with beads for this issue until the todo list includes it as a pending item ` +
          `(content "${title}", a present-continuous activeForm, status pending).`
        );
      }
      process.exit(0);
    }

    // ─── bd claim / status in_progress ───────────────────────────
    const claimMatch = cmd.match(/^bd\s+update\s+([\w-]+).*--claim/)
                    || cmd.match(/^bd\s+update\s+([\w-]+).*--status\s+in_progress/);
    if (claimMatch) {
      emit(
        `beads issue ${claimMatch[1]} is now in_progress. ` +
        `The Claude Code todo list is out of sync until that item's status reflects in_progress (only one item should be in_progress at a time).`
      );
      process.exit(0);
    }

    // ─── bd close / status closed ────────────────────────────────
    const closeMatch = cmd.match(/^bd\s+close\s+([\w-]+)/)
                    || cmd.match(/^bd\s+update\s+([\w-]+).*--status\s+closed/);
    if (closeMatch) {
      emit(
        `beads issue ${closeMatch[1]} is now closed. ` +
        `The Claude Code todo list is out of sync until that item's status reflects completed.`
      );
      process.exit(0);
    }
  } catch {
    // Hooks must never break the tool call. Swallow.
  }
  process.exit(0);
});
