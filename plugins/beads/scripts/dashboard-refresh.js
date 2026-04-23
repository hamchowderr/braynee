// dashboard-refresh.js
// Beads plugin — PostToolUse hook (Bash, async)
// Regenerates the beads dashboard whenever any `bd` command runs.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CODE_DIR = path.join(process.env.USERPROFILE || os.homedir(), 'code');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const cmd = (data.tool_input && data.tool_input.command) || '';
    const cwd = data.cwd || process.cwd();

    // Only fire on bd commands inside a ~/code/* beads project
    if (!/^bd(\s|$)/.test(cmd.trim())) process.exit(0);
    if (!cwd.toLowerCase().startsWith(CODE_DIR.toLowerCase())) process.exit(0);
    if (!fs.existsSync(path.join(cwd, '.beads'))) process.exit(0);

    execSync(`node "${path.join(__dirname, 'beads-dashboard.js')}"`, {
      cwd, encoding: 'utf8', timeout: 30000, stdio: 'ignore',
    });

    process.exit(0);
  } catch {
    process.exit(0);
  }
});
