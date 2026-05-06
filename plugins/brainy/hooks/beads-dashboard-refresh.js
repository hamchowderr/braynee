// beads-dashboard-refresh.js
// Hook: PostToolUse (Bash, async) — regenerates beads dashboard whenever any bd command runs.
// Fires silently in background; never blocks Claude.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CODE_DIR = path.join(os.homedir(), 'code');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const cmd = (data.tool_input && data.tool_input.command) || '';
    const cwd = (data.cwd || process.cwd()).replace(/\//g, path.sep);

    // Only fire on bd commands
    if (!/^bd(\s|$)/.test(cmd.trim())) process.exit(0);

    // Must be in a beads project under ~/code/
    if (!cwd.toLowerCase().startsWith(CODE_DIR.toLowerCase())) process.exit(0);
    if (!fs.existsSync(path.join(cwd, '.beads'))) process.exit(0);

    // Register project in sessions file (catches projects opened mid-session from vault)
    const SESSIONS_FILE = path.join(CLAUDE_DIR, 'beads-active-sessions.json');
    try {
      let sessions = {};
      try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch {}
      const projectName = path.relative(CODE_DIR, cwd).split(path.sep)[0];
      sessions[projectName] = { path: path.join(CODE_DIR, projectName), lastSeen: new Date().toISOString() };
      const cutoff = Date.now() - 72 * 60 * 60 * 1000;
      for (const [k, v] of Object.entries(sessions)) {
        if (new Date(v.lastSeen).getTime() < cutoff) delete sessions[k];
      }
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions));
    } catch {}

    // Regenerate shared dashboard (all active sessions)
    const dashboardPath = path.join(CLAUDE_DIR, 'beads-dashboard.html');
    execSync(`node "${path.join(__dirname, '..', 'scripts', 'beads-dashboard.js')}" --sessions-only --output "${dashboardPath}"`, {
      cwd, encoding: 'utf8', timeout: 60000, stdio: 'ignore',
    });

    process.exit(0);
  } catch {
    process.exit(0);
  }
});
