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

function emit(text) {
  process.stdout.write(`<system-reminder>BEADS-TODO-MIRROR: ${text}</system-reminder>\n`);
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
          `bd ${idMatch[1]} created ("${title}"). ` +
          `Call TodoWrite NOW to add { content: "${title}", activeForm: "<verb-ing form, e.g. 'Wiring Stripe webhook'>", status: "pending" } so the user can see the new task in the terminal todo panel.`
        );
      }
      process.exit(0);
    }

    // ─── bd claim / status in_progress ───────────────────────────
    const claimMatch = cmd.match(/^bd\s+update\s+([\w-]+).*--claim/)
                    || cmd.match(/^bd\s+update\s+([\w-]+).*--status\s+in_progress/);
    if (claimMatch) {
      emit(
        `bd ${claimMatch[1]} is now in_progress. ` +
        `Call TodoWrite NOW to set that todo's status to "in_progress" (and ensure only one item is in_progress at a time).`
      );
      process.exit(0);
    }

    // ─── bd close / status closed ────────────────────────────────
    const closeMatch = cmd.match(/^bd\s+close\s+([\w-]+)/)
                    || cmd.match(/^bd\s+update\s+([\w-]+).*--status\s+closed/);
    if (closeMatch) {
      emit(
        `bd ${closeMatch[1]} is now closed. ` +
        `Call TodoWrite NOW to set that todo's status to "completed".`
      );
      process.exit(0);
    }
  } catch {
    // Hooks must never break the tool call. Swallow.
  }
  process.exit(0);
});
