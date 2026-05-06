// Hook: TaskCompleted — fires when a task is marked complete
// Complement to task-created-check.js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CODE_DIR = path.join(process.env.USERPROFILE, 'code');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const cwd = data.cwd || process.cwd();
    const taskName = data.task_name || data.task_subject || '';

    if (!cwd.toLowerCase().startsWith(CODE_DIR.toLowerCase())) process.exit(0);
    if (!fs.existsSync(path.join(cwd, '.beads'))) process.exit(0);

    process.stdout.write(`Task completed: ${taskName}`);
  } catch {}
  process.exit(0);
});
