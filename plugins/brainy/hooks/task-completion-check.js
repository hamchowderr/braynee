// task-completion-check.js
// Hook: Stop — Cross-verifies all four tracking layers at session end.
//
// Checks:
//   1. mtn timer status (CLI — no localhost:8081 dependency)
//   2. beads-active-issue.json (state file written by beads-status-sync)
//   3. Beads in_progress issues (bd list --json)
//   4. Cross-verifies: timer ↔ active-issue ↔ beads in_progress
//
// Never hard-blocks (exit 0 always). Surfaces discrepancies via systemMessage
// so Claude can prompt the user to wrap up before stopping.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const ACTIVE_ISSUE_FILE = path.join(HOME, '.claude', 'beads-active-issue.json');

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'ignore'], ...opts }).trim();
  } catch { return null; }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const cwd = data.cwd || process.cwd();

    const warnings = [];
    const currentProject = path.basename(cwd).toLowerCase();
    const hasBeadsDir = fs.existsSync(path.join(cwd, '.beads'));

    // ── 1. mtn timer ──────────────────────────────────────────────────
    const timerStatus = run('mtn timer status');
    const timerRunning = timerStatus && !/no.*(active|running|timer)|not running|stopped/i.test(timerStatus);
    if (timerRunning) {
      warnings.push(`mtn timer is still running: ${timerStatus.split('\n')[0]}`);
    }

    // ── 2. beads-active-issue.json ────────────────────────────────────
    let activeIssue = null;
    try {
      if (fs.existsSync(ACTIVE_ISSUE_FILE)) {
        activeIssue = JSON.parse(fs.readFileSync(ACTIVE_ISSUE_FILE, 'utf-8'));
      }
    } catch {}

    // Stale-check: if the file is older than 12h, OR the bd issue says the work
    // is already closed, treat the pointer as stale and auto-clear it.
    if (activeIssue) {
      const ageMs = Date.now() - new Date(activeIssue.startedAt || 0).getTime();
      const isOld = ageMs > 12 * 60 * 60 * 1000;
      let bdSaysClosed = false;
      if (hasBeadsDir) {
        const showJson = run(`bd show ${activeIssue.id} --json`, { cwd });
        if (showJson) {
          try { bdSaysClosed = JSON.parse(showJson).status === 'closed'; } catch {}
        }
      }
      if (isOld || bdSaysClosed) {
        try { fs.unlinkSync(ACTIVE_ISSUE_FILE); } catch {}
        activeIssue = null;
      }
    }

    // Only warn about the active issue if it belongs to this session's project
    const activeProject = activeIssue?.project?.toLowerCase() || null;
    const activeIsCurrentProject = hasBeadsDir && activeProject && activeProject === currentProject;
    if (activeIssue && activeIsCurrentProject) {
      warnings.push(`Active issue not closed: [${activeIssue.id}] ${activeIssue.title}`);
    }

    // ── 3. Beads in_progress (if in a beads project) ──────────────────
    let inProgressIssues = [];
    if (hasBeadsDir) {
      const raw = run('bd list --json --all', { cwd });
      if (raw) {
        try {
          const issues = JSON.parse(raw);
          inProgressIssues = issues.filter(i => i.status === 'in_progress');
          if (inProgressIssues.length > 0) {
            const list = inProgressIssues.map(i => `    [${i.id}] ${i.title}`).join('\n');
            warnings.push(`${inProgressIssues.length} beads issue(s) still in_progress:\n${list}`);
          }
        } catch {}
      }
    }

    // ── 4. Cross-verification ─────────────────────────────────────────

    if (activeIssue && activeIsCurrentProject && inProgressIssues.length > 0 && !inProgressIssues.find(i => i.id === activeIssue.id)) {
      warnings.push(`SYNC MISMATCH: active-issue.json points to [${activeIssue.id}] but that issue is NOT in_progress in beads`);
    }
    if (!activeIssue && inProgressIssues.length > 0) {
      warnings.push(`SYNC MISMATCH: beads has in_progress issue(s) but active-issue.json is missing — beads-status-sync may not have fired`);
    }
    if (timerRunning && !activeIssue && inProgressIssues.length === 0) {
      warnings.push(`ORPHANED TIMER: mtn timer is running but no active beads issue — stop the timer with \`mtn timer stop\``);
    }

    if (warnings.length === 0) {
      process.exit(0);
    }

    const msg = [
      '⚠ UNFINISHED WORK — resolve before stopping:',
      '',
      ...warnings.map(w => `• ${w}`),
      '',
      'To close: `bd close <id>` or `bd update <id> --status blocked`',
      'Timer will be auto-stopped by auto-stop-timers hook.',
    ].join('\n');

    process.stdout.write(JSON.stringify({ systemMessage: msg }));
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
