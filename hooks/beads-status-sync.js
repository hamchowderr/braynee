// beads-status-sync.js
// Hook: PostToolUse (Bash) — single source of truth for all beads status changes.
// Replaces beads-claim-to-tasknotes.js (consolidated here).
//
// Handles:
//   bd create "title" ...             → create matching mtn task at planning time (status: open, no timer)
//   bd update <id> --claim            → in_progress: session note + mtn task + timer + active-issue.json
//   bd update <id> --status in_progress → same as above
//   bd update <id> --status closed    → session note + stop timer + clear active-issue.json + mtn complete
//   bd update <id> --status open/blocked → session note only
//   bd close <id>                     → same as closed (also marks mtn task complete)

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findBeadsRoot } = require(path.join(__dirname, 'lib', 'is-code-context.js'));
const TN = require(path.join(__dirname, 'lib', 'tasknotes-mirror.js'));

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

// TaskNotes mirror helpers live in lib/tasknotes-mirror.js (shared with
// prd-seed.mjs — cp-8ru). Aliased so the call sites below read unchanged.
const { findMtnTaskByIssueId, completeMtnTaskByIssueId, ensureMtnTask } = TN;

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

    // ─── bd create: mirror new issue to mtn at planning time ─────────
    if (/^bd\s+create\s/.test(cmd)) {
      // The new issue ID is in the bd create response. Real beads output is
      // `✓ Created issue: <workspace-prefixed-id> — <title>`, so we can't
      // assume a literal `bd-` prefix; the prefix is whatever the workspace
      // is configured to use. Fall back to the legacy `bd-...` form for
      // older installs.
      const stdout = data.tool_response?.stdout || data.tool_response?.output || '';
      const idMatch = stdout.match(/Created\s+issue:?\s*([A-Za-z][\w-]+)/i)
                   || stdout.match(/\b(bd-[\w-]+)\b/);

      // Title can be supplied as either a positional argument
      // (`bd create "Title"`) or as a --title flag
      // (`bd create --title="Title"` / `bd create --title Title`).
      // Try the flag form first since that's what newer beads + agents use.
      let title = '';
      const flagDouble = cmd.match(/--title\s*=\s*"([^"]+)"/);
      const flagSingle = cmd.match(/--title\s*=\s*'([^']+)'/);
      const flagBare   = cmd.match(/--title\s*=\s*([^\s"'][^\s"']*)/);
      const flagSpaceDouble = cmd.match(/--title\s+"([^"]+)"/);
      const flagSpaceSingle = cmd.match(/--title\s+'([^']+)'/);
      if (flagDouble) title = flagDouble[1];
      else if (flagSingle) title = flagSingle[1];
      else if (flagSpaceDouble) title = flagSpaceDouble[1];
      else if (flagSpaceSingle) title = flagSpaceSingle[1];
      else if (flagBare) title = flagBare[1];
      else {
        const posArg = cmd.match(/bd\s+create\s+(?:"([^"]+)"|'([^']+)')/);
        if (posArg) title = posArg[1] || posArg[2] || '';
      }
      title = title.trim();

      const prioMatch = cmd.match(/(?:--priority\s*=\s*|-p\s+)(P[0-4]|critical|high|medium|low|[0-4])/i);
      const prioRaw = prioMatch ? prioMatch[1] : null;
      const priority = prioRaw
        ? (/^[0-4]$/.test(prioRaw) ? PRIORITY_MAP[parseInt(prioRaw)]
           : /^P[0-4]$/i.test(prioRaw) ? (PRIORITY_MAP[parseInt(prioRaw.replace(/^P/i, ''))] || 'medium')
           : prioRaw.toLowerCase())
        : 'medium';
      if (idMatch && title) {
        const folderName = path.basename(cwd);
        const projectName = findProjectName(folderName);
        const projectSlug = (projectName || folderName)
          .split(/[-_\s]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
        ensureMtnTask(idMatch[1], title, priority, projectSlug);
      }
      process.exit(0);
    }

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

      // Mark the linked mtn task complete (gated to avoid no-op churn).
      // The reverse listener (mtn-to-beads-sync.js) is guarded against re-entry
      // because by the time it runs, bd will already be in 'closed' status.
      if (findMtnTaskByIssueId(issueId)) completeMtnTaskByIssueId(issueId);

      // Clear active issue if it was this one
      try {
        const active = JSON.parse(fs.readFileSync(ACTIVE_ISSUE_FILE, 'utf-8'));
        if (active.id === issueId) fs.unlinkSync(ACTIVE_ISSUE_FILE);
      } catch {}
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
