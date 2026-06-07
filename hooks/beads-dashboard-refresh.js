// beads-dashboard-refresh.js
// Hook: PostToolUse (Bash, async) — regenerates beads dashboard whenever any bd command runs.
// Fires silently in background; never blocks Claude.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { findCodeRoot } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    let data = {};
    try { data = JSON.parse(input); } catch { data = {}; }
    const cmd = (data.tool_input && data.tool_input.command) || '';
    const cwd = (data.cwd || process.cwd()).replace(/\//g, path.sep);

    // Only fire on bd commands
    if (!/^bd(\s|$)/.test(cmd.trim())) process.exit(0);

    // Hard cap (dolt-guard): if the machine is already flooded with dolt servers,
    // do nothing that could start another. Going quiet during a runaway is correct.
    if (require(path.join(__dirname, 'lib', 'dolt-guard.js')).overCap()) process.exit(0);

    // F-3.2a: this is a per-bd-command PostToolUse refresh (it deliberately
    // tracks whichever project a bd command ran in, including projects opened
    // mid-session from the vault), so it correctly keys off the event cwd —
    // detected structurally instead of a hardcoded ~/code prefix.
    const codeRoot = findCodeRoot(cwd);
    if (!codeRoot) process.exit(0);
    if (!fs.existsSync(path.join(codeRoot, '.beads'))) process.exit(0);

    // Register project in sessions file (catches projects opened mid-session from vault)
    const SESSIONS_FILE = path.join(CLAUDE_DIR, 'beads-active-sessions.json');
    try {
      let sessions = {};
      try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch {}
      const projectName = path.basename(codeRoot);
      sessions[projectName] = { path: codeRoot, lastSeen: new Date().toISOString() };
      const cutoff = Date.now() - 72 * 60 * 60 * 1000;
      for (const [k, v] of Object.entries(sessions)) {
        if (new Date(v.lastSeen).getTime() < cutoff) delete sessions[k];
      }
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions));
    } catch {}

    // Regenerate shared dashboard (all active sessions)
    const dashboardPath = path.join(CLAUDE_DIR, 'beads-dashboard.html');
    execSync(`node "${path.join(__dirname, '..', 'scripts', 'beads-dashboard.js')}" --sessions-only --output "${dashboardPath}"`, {
      cwd: codeRoot, encoding: 'utf8', timeout: 60000, stdio: 'ignore', windowsHide: true,
    });

    process.exit(0);
  } catch {
    process.exit(0);
  }
});
