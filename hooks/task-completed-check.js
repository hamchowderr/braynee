// Hook: TaskCompleted — fires when a task is marked complete
// Complement to task-created-check.js
const path = require('path');
const { findCodeRoot, findBeadsRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }
    const taskName = data.task_name || data.task_subject || '';

    // F-3.2a + F-3.2b: only act in a beads code context, detected
    // structurally on the SESSION's working dir — not a ~/code prefix.
    // findBeadsRoot excludes the global ~/.beads (bd init --shared-server).
    const codeRoot = findCodeRoot(sessionDir(data));
    if (!codeRoot) process.exit(0);
    if (!findBeadsRoot(codeRoot)) process.exit(0);

    process.stdout.write(`Task completed: ${taskName}`);
  } catch {}
  process.exit(0);
});
