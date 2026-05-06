// beads-status-sync.js
// Hook: PostToolUse (Bash) — single source of truth for all beads status changes.
// Replaces beads-claim-to-tasknotes.js (consolidated here).
//
// Handles:
//   bd update <id> --claim            → in_progress: session note + mtn task + timer + active-issue.json
//   bd update <id> --status in_progress → same as above
//   bd update <id> --status closed    → session note + stop timer + clear active-issue.json
//   bd update <id> --status open/blocked → session note only
//   bd close <id>                     → same as closed

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const VAULT_DIR = path.join(HOME, 'Obsidian Vault');
const SESSIONS_DIR = path.join(VAULT_DIR, '2. Areas', 'Sessions');
const CODE_DIR = path.join(HOME, 'code');
const ACTIVE_ISSUE_FILE = path.join(HOME, '.claude', 'beads-active-issue.json');

const PRIORITY_MAP = { 0: 'critical', 1: 'high', 2: 'medium', 3: 'low', 4: 'low' };

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'], ...opts }).trim();
  } catch { return null; }
}

function findProjectName(folderName) {
  const projectsDir = path.join(VAULT_DIR, '1. Projects');
  if (!fs.existsSync(projectsDir)) return null;
  for (const file of fs.readdirSync(projectsDir).filter(f => f.endsWith('.md'))) {
    try {
      const content = fs.readFileSync(path.join(projectsDir, file), 'utf8');
      const folderMatch = content.match(/^folder:\s*"?([^"\n]+)"?$/m);
      if (folderMatch && folderMatch[1].trim().toLowerCase() === folderName.toLowerCase()) {
        const nameMatch = content.match(/^name:\s*"?([^"\n]+)"?$/m);
        return nameMatch ? nameMatch[1].trim() : file.replace('.md', '');
      }
    } catch { continue; }
  }
  return null;
}

function findActiveSession(projectName) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  const projectSlug = projectName.replace(/[^a-zA-Z0-9]+/g, '-');

  function walkMd(dir) {
    const results = [];
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) results.push(...walkMd(path.join(dir, entry.name)));
        else if (entry.isFile() && entry.name.endsWith('.md')) results.push(path.join(dir, entry.name));
      }
    } catch {}
    return results;
  }

  const dirs = [path.join(SESSIONS_DIR, projectSlug), SESSIONS_DIR].filter(d => fs.existsSync(d));
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

function sanitizeTitle(title) {
  return title.replace(/:/g, ' -').replace(/[/\\*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function mtnTaskExists(title) {
  const result = run(`mtn search ${JSON.stringify(title.slice(0, 40))}`);
  return result && !/no tasks matching/i.test(result);
}

function ensureMtnTask(issueId, title, priority, projectSlug) {
  // Check if task already exists
  if (mtnTaskExists(title)) return sanitizeTitle(title);

  const safeTitle = sanitizeTitle(title);
  const mtnText = `${safeTitle} +${projectSlug} [${priority}] #task #${issueId}`;
  run(`mtn create ${JSON.stringify(mtnText)}`);
  return safeTitle;
}

// ─── Main ────────────────────────────────────────────────────────────────────
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const cmd = (data.tool_input?.command || '').trim();
    const cwd = data.cwd || process.cwd();

    if (!fs.existsSync(path.join(cwd, '.beads'))) process.exit(0);

    // Detect all bd status-change patterns
    const claimMatch  = cmd.match(/^bd\s+update\s+([\w-]+).*--claim/);
    const statusMatch = !claimMatch && cmd.match(/^bd\s+update\s+([\w-]+).*--status\s+(in_progress|open|blocked|closed)/);
    const closeMatch  = !claimMatch && !statusMatch && cmd.match(/^bd\s+close\s+([\w-]+)/);

    if (!claimMatch && !statusMatch && !closeMatch) process.exit(0);

    const issueId = (claimMatch || statusMatch || closeMatch)[1];
    const newStatus = claimMatch ? 'in_progress' : statusMatch ? statusMatch[2] : 'closed';

    const folderName = path.basename(cwd);
    const projectName = findProjectName(folderName);
    const projectSlug = (projectName || folderName)
      .split(/[-_\s]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-');

    const issue = getIssueDetails(issueId, cwd);

    // ─── 1. Update session note ──────────────────────────────────────
    if (projectName) {
      const session = findActiveSession(projectName);
      if (session) {
        const label = { in_progress: 'Started', open: 'Reopened', blocked: 'Blocked', closed: 'Completed' }[newStatus] || newStatus;
        appendToSessionProgress(session.filepath, session.content, `${label} [${issueId}] ${issue.title}`);
      }
    }

    // ─── 2. TaskNotes + timer sync ───────────────────────────────────
    if (newStatus === 'in_progress') {
      const mtnTitle = ensureMtnTask(issueId, issue.title, issue.priority, projectSlug);

      // Stop any currently running timer before starting a new one
      run('mtn timer stop');

      // Start timer for this task
      run(`mtn timer start ${JSON.stringify(mtnTitle)}`);

      // Write active issue state for dashboard
      fs.writeFileSync(ACTIVE_ISSUE_FILE, JSON.stringify({
        id: issueId,
        title: issue.title,
        mtnTitle,
        priority: issue.priority,
        startedAt: new Date().toISOString(),
        project: projectName || folderName,
      }), 'utf-8');

    } else if (newStatus === 'closed') {
      // Stop running timer
      run('mtn timer stop');

      // Clear active issue if it was this one
      try {
        const active = JSON.parse(fs.readFileSync(ACTIVE_ISSUE_FILE, 'utf-8'));
        if (active.id === issueId) fs.unlinkSync(ACTIVE_ISSUE_FILE);
      } catch {}
    }

    // Regenerate shared dashboard (all active sessions)
    const dashPath = path.join(HOME, '.claude', 'beads-dashboard.html');
    run(`node "${path.join(HOME, '.claude', 'scripts', 'beads-dashboard.js')}" --sessions-only --output "${dashPath}"`, { cwd });

    process.exit(0);
  } catch {
    process.exit(0);
  }
});
