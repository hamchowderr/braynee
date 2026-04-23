// session-start.js
// Beads plugin — SessionStart hook (async)
// Regenerates the beads dashboard and auto-opens it when a session starts
// inside a ~/code/* project that has beads initialized.

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CODE_DIR = path.join(process.env.USERPROFILE || os.homedir(), 'code');
const HOME_DIR = process.env.USERPROFILE || os.homedir();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(input);
    const cwd = data.cwd || process.cwd();

    // Only run when inside a ~/code/* project with beads
    if (!cwd.toLowerCase().startsWith(CODE_DIR.toLowerCase())) process.exit(0);
    if (!fs.existsSync(path.join(cwd, '.beads'))) process.exit(0);

    const dashboardScript = path.join(__dirname, 'beads-dashboard.js');
    const dashboardOutput = path.join(HOME_DIR, '.claude', 'beads-dashboard.html');

    try {
      execSync(`node "${dashboardScript}"`, {
        cwd, encoding: 'utf8', timeout: 30000, stdio: 'ignore',
      });
      spawn('cmd', ['/c', 'start', '', dashboardOutput], {
        detached: true, stdio: 'ignore',
      }).unref();
    } catch {}

    process.exit(0);
  } catch {
    process.exit(0);
  }
});
