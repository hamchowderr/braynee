// task-created-check.js
// Hook: TaskCreated — Blocks task creation if Beads isn't initialized
// Checks for .beads/ directory in the project root (created by `bd init`)
// Exit 0 = allow creation, Exit 2 = block with feedback to model
// Only applies to projects in the code directory (not workspace or other dirs)

const fs = require('fs');
const path = require('path');

const CODE_DIR = path.join(process.env.USERPROFILE, 'code');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const cwd = data.cwd || process.cwd();

    // Only enforce for code projects, not workspace or other dirs
    if (!cwd.toLowerCase().startsWith(CODE_DIR.toLowerCase())) {
      process.exit(0);
    }
    if (path.basename(cwd).toLowerCase() === 'workspace') {
      process.exit(0);
    }

    // Walk up from cwd looking for .beads/ directory (bd init creates it)
    let dir = cwd;
    const root = path.parse(dir).root;
    let beadsFound = false;

    while (dir !== root) {
      if (fs.existsSync(path.join(dir, '.beads'))) {
        beadsFound = true;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

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
