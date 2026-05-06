// check-beads-init.js
// Hook: SessionStart — Checks if Beads is initialized for the current project.
// Emits a warning message (stdout) if .beads/ not found in a code project.
// Never blocks (always exit 0) — just injects a reminder.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CODE_DIR = path.join(os.homedir(), 'code');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const cwd = data.cwd || process.cwd();

    // Only enforce for code projects
    if (!cwd.toLowerCase().startsWith(CODE_DIR.toLowerCase())) {
      process.exit(0);
    }
    // Skip workspace root
    if (path.basename(cwd).toLowerCase() === 'workspace') {
      process.exit(0);
    }

    // Walk up from cwd looking for .beads/ directory
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
      const projectName = path.basename(cwd);
      process.stdout.write(
        `# Beads Not Initialized\n\n` +
        `**MANDATORY**: Beads issue tracking is required for ALL projects.\n` +
        `Project \`${projectName}\` does not have beads initialized.\n\n` +
        `Run \`bd init --shared-server -p ${projectName} --skip-agents --skip-hooks\` ` +
        `before starting any work. Use \`--shared-server\` to avoid port conflicts.\n`
      );
    }

    process.exit(0);
  } catch {
    process.exit(0);
  }
});
