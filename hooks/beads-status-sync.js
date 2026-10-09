// beads-status-sync.js
// Hook: PostToolUse (Bash) — single source of truth for all beads status changes.
//
// Handles:
//   bd update <id> --claim            → in_progress: session note + active-issue.json
//   bd update <id> --status in_progress → same as above
//   bd update <id> --status closed    → session note + clear active-issue.json
//   bd update <id> --status open/blocked → session note only
//   bd close <id>                     → same as closed

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findBeadsRoot } = require(path.join(__dirname, 'lib', 'is-code-context.js'));
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { bdSucceeded } = require(path.join(__dirname, 'lib', 'bd-command-result.js'));
const HOOK = 'beads-status-sync';

const HOME = os.homedir();
const { getVaultRoot } = require(path.join(__dirname, '..', 'scripts', 'lib', 'vault-root.js'));
const VAULT_DIR = getVaultRoot();
const SESSIONS_DIR = path.join(VAULT_DIR, '2. Areas', 'Sessions');
const ACTIVE_ISSUE_FILE = path.join(HOME, '.claude', 'beads-active-issue.json');
// Bundled dashboard generator (F-5.3): use the plugin's own copy, not a
// hardcoded ~/.claude/scripts/ path that may not exist on a fresh install.
const DASHBOARD_SCRIPT = path.join(__dirname, '..', 'scripts', 'beads-dashboard.js');

const PRIORITY_MAP = { 0: 'critical', 1: 'high', 2: 'medium', 3: 'low', 4: 'low' };

const { overCap } = require(path.join(__dirname, 'lib', 'dolt-guard.js'));

function run(cmd, opts = {}) {
  if (overCap()) return null; // dolt-guard: never risk spawning a dolt server during a flood
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, ...opts }).trim();
  } catch { return null; }
}

// cp-7kfh: one shared, RECURSIVE lookup. This was a local copy that read only
// `1. Projects/*.md` and so missed every note nested in a project subfolder.
const { findProjectName: lookupProjectName } = require(path.join(__dirname, 'lib', 'vault-projects.js'));
function findProjectName(folderName) {
  return lookupProjectName(folderName, VAULT_DIR);
}

// cp-g3xp: the ONE project-name → Sessions folder mapping, legacy dashed
// folders included on the read side.
const { existingSessionFolders } = require(path.join(__dirname, 'lib', 'session-folder.js'));

function findActiveSession(projectName) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;

  function walkMd(dir) {
    const results = [];
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) results.push(...walkMd(path.join(dir, entry.name)));
        else if (entry.isFile() && entry.name.endsWith('.md')) results.push(path.join(dir, entry.name));
      }
    } catch (e) {
      // Partial results are returned, so a failed walk makes session notes look
      // absent and the status sync silently skips them.
      log.debug(HOOK, `session-note walk failed under ${dir}: ${e && e.message}`);
    }
    return results;
  }

  // The project's own folder(s) first — its name, then a legacy dashed folder
  // if one exists — then all of Sessions/.
  const dirs = [...existingSessionFolders(SESSIONS_DIR, projectName), SESSIONS_DIR];
  const seen = new Set();
  for (const dir of dirs) {
    for (const filepath of walkMd(dir).sort((a, b) => path.basename(b).localeCompare(path.basename(a)))) {
      if (seen.has(filepath)) continue;
      seen.add(filepath);
      try {
        const content = fs.readFileSync(filepath, 'utf8');
        const statusMatch = content.match(/^status:\s*(\S+)/m);
        if (!statusMatch || statusMatch[1] !== 'active') continue;
        const projectMatch = content.match(/^project:\s*"?\[?\[?([^\]"\n]+)\]?\]?"?/m);
        if (projectMatch && projectMatch[1].trim().toLowerCase() === projectName.toLowerCase()) {
          return { filepath, content };
        }
      } catch { continue; }
    }
  }
  return null;
}

function appendToSessionProgress(filepath, content, line) {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const entry = `- ${timestamp}: ${line}`;
  let updated;
  const progressRegex = /(## Progress\s*\n)([\s\S]*?)(?=\n## |\n$)/;
  if (progressRegex.test(content)) {
    updated = content.replace(progressRegex, (_, header, body) => {
      const trimmed = body.trimEnd();
      return `${header}${trimmed.match(/^\(session just|^\(none/i) ? '' : trimmed + '\n'}${entry}\n`;
    });
  } else {
    updated = content.trimEnd() + `\n\n## Progress\n${entry}\n`;
  }
  fs.writeFileSync(filepath, updated.replace(/\r\n/g, '\n'), 'utf-8');
}

function getIssueDetails(issueId, cwd) {
  try {
    const out = run(`bd show ${issueId}`, { cwd });
    if (!out) return { title: issueId, priority: 'medium' };
    const firstLine = out.split('\n')[0];
    const titleMatch = firstLine.match(/·\s+(.+?)\s+\[/);
    const prioMatch = firstLine.match(/P(\d)/);
    return {
      title: titleMatch ? titleMatch[1].trim() : issueId,
      priority: prioMatch ? (PRIORITY_MAP[parseInt(prioMatch[1])] || 'medium') : 'medium',
    };
  } catch { return { title: issueId, priority: 'medium' }; }
}

// ─── Main ────────────────────────────────────────────────────────────────────
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    let data = {};
    try { data = JSON.parse(input); } catch { data = {}; }
    const cmd = (data.tool_input?.command || '').trim();
    const eventCwd = data.cwd || process.cwd();

    // F-3.2a: this is a per-command PostToolUse sync (reacts to the bd command
    // that just ran), so it correctly keys off the event cwd — but resolve the
    // .beads root by walking up, EXCLUDING the global ~/.beads from
    // `bd init --shared-server` (findBeadsRoot). Run bd at that root.
    const beadsRoot = findBeadsRoot(eventCwd);
    if (!beadsRoot) process.exit(0);
    const cwd = beadsRoot;

    // cp-snh2: this hook writes the session note and beads-active-issue.json. Doing that for a bd command that FAILED records an
    // event with no counterpart in beads. Suppresses only on visible failure.
    if (!bdSucceeded(data)) {
      log.debug(HOOK, `bd command did not succeed — nothing written: ${cmd.slice(0, 80)}`);
      process.exit(0);
    }

    // Detect all bd status-change patterns
    const claimMatch  = cmd.match(/^bd\s+update\s+([\w.-]+).*--claim/);
    const statusMatch = !claimMatch && cmd.match(/^bd\s+update\s+([\w.-]+).*--status\s+(in_progress|open|blocked|closed)/);
    const closeMatch  = !claimMatch && !statusMatch && cmd.match(/^bd\s+close\s+([\w.-]+)/);

    if (!claimMatch && !statusMatch && !closeMatch) process.exit(0);

    const issueId = (claimMatch || statusMatch || closeMatch)[1];
    const newStatus = claimMatch ? 'in_progress' : statusMatch ? statusMatch[2] : 'closed';

    const folderName = path.basename(cwd);
    const projectName = findProjectName(folderName);

    const issue = getIssueDetails(issueId, cwd);

    // ─── 1. Update session note ──────────────────────────────────────
    if (projectName) {
      const session = findActiveSession(projectName);
      if (session) {
        const label = { in_progress: 'Started', open: 'Reopened', blocked: 'Blocked', closed: 'Completed' }[newStatus] || newStatus;
        appendToSessionProgress(session.filepath, session.content, `${label} [${issueId}] ${issue.title}`);
      }
    }

    // ─── 2. Active-issue state ───────────────────────────────────────
    if (newStatus === 'in_progress') {
      // Write active issue state for dashboard
      fs.writeFileSync(ACTIVE_ISSUE_FILE, JSON.stringify({
        id: issueId,
        title: issue.title,
        priority: issue.priority,
        startedAt: new Date().toISOString(),
        project: projectName || folderName,
      }), 'utf-8');

    } else if (newStatus === 'closed') {
      // Clear active issue if it was this one
      try {
        const active = JSON.parse(fs.readFileSync(ACTIVE_ISSUE_FILE, 'utf-8'));
        if (active.id === issueId) fs.unlinkSync(ACTIVE_ISSUE_FILE);
      } catch { /* active-issue file absent or already removed — nothing to clear */ }
    }

    // Regenerate shared dashboard (all active sessions). F-5.3: use the
    // bundled generator, consistent with beads-dashboard-refresh.js.
    const dashPath = path.join(HOME, '.claude', 'beads-dashboard.html');
    run(`node "${DASHBOARD_SCRIPT}" --sessions-only --output "${dashPath}"`, { cwd });

    process.exit(0);
  } catch {
    process.exit(0);
  }
});
