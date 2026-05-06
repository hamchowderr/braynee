// pre-compact-snapshot.js
// Hook: PreCompact — Updates session note and captures dynamic state before compaction
// Matcher: "" (all compactions)
// Input: JSON on stdin from Claude Code
// Output: Writes snapshot to a temp file that reinject-after-compact.ps1 reads back
// Exit 0 = allow compaction to proceed
//
// v3 changes:
// - Fixed path: '2. Areas/Sessions' (was '2. Areas/1. Sessions' — didn't exist)
// - UPDATES the session note with recent git commits before snapshotting
//   This ensures the note is fresh even if Claude ignored nudges
// - Saves active session note PATH so reinject can read full content

const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const VAULT_QUERY = path.join(__dirname, '..', 'scripts', 'vault-query.mjs');
const TASKNOTES = path.join(__dirname, '..', 'scripts', 'tasknotes.mjs');
const VAULT_DIR = path.join(os.homedir(), 'Obsidian Vault');
const SESSIONS_DIR = path.join(VAULT_DIR, '2. Areas', 'Sessions');
const CODE_DIR = path.join(os.homedir(), 'code');
const SNAPSHOT_FILE = path.join(os.homedir(), '.claude', 'compact-snapshot.json');
const CONTEXT_CACHE = path.join(os.homedir(), '.claude', 'vault-context-cache.json');

function findProjectName(folderName) {
  const projectsDir = path.join(VAULT_DIR, '1. Projects');
  if (!fs.existsSync(projectsDir)) return null;

  const files = fs.readdirSync(projectsDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(projectsDir, file), 'utf8');
      const folderMatch = content.match(/^folder:\s*"?([^"\n]+)"?$/m);
      if (folderMatch && folderMatch[1].trim().toLowerCase() === folderName.toLowerCase()) {
        const nameMatch = content.match(/^name:\s*"?([^"\n]+)"?$/m);
        if (nameMatch) return nameMatch[1].trim();
        return file.replace('.md', '');
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000 }).trim();
  } catch (e) {
    return null;
  }
}

// Find active session note for a project, returns { filename, filepath, content } or null
function findActiveSession(projectName) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;

  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.md'));
  files.sort((a, b) => b.localeCompare(a));

  for (const file of files) {
    try {
      const filepath = path.join(SESSIONS_DIR, file);
      const content = fs.readFileSync(filepath, 'utf8');

      const statusMatch = content.match(/^status:\s*(\S+)/m);
      if (!statusMatch || statusMatch[1] !== 'active') continue;

      const projectMatch = content.match(/^project:\s*"?\[?\[?([^\]"\n]+)\]?\]?"?/m);
      if (!projectMatch) continue;

      if (projectMatch[1].trim().toLowerCase() === projectName.toLowerCase()) {
        return { filename: file, filepath, content };
      }
    } catch {
      continue;
    }
  }
  return null;
}

// Get recent git commits for progress update
function getRecentCommits(cwd) {
  try {
    const log = execSync(
      'git log --all --oneline --since="24 hours ago" --no-merges --format="%h %s"',
      { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 }
    ).trim();
    if (!log) return [];
    return log.split('\n').filter(Boolean).slice(0, 15);
  } catch {
    return [];
  }
}

// Update the session note with current state BEFORE snapshotting
function updateSessionNote(session, cwd) {
  let content = session.content;
  let changed = false;
  const now = new Date().toISOString();

  // Add a compaction marker to Progress so there's a visible trail
  const compactMarker = `- *(auto-saved before compaction at ${now.split('T')[1].split('.')[0]})*`;

  // Append recent git commits to Progress if they aren't already there
  const commits = getRecentCommits(cwd);
  if (commits.length > 0) {
    const progressRegex = /(## Progress\s*\n)([\s\S]*?)(?=\n## |\n$)/;
    const match = content.match(progressRegex);
    if (match) {
      const existingProgress = match[2];
      // Only add commits not already in the progress section
      const newCommits = commits.filter(c => {
        const hash = c.split(' ')[0];
        return !existingProgress.includes(hash);
      });
      if (newCommits.length > 0) {
        const commitLines = newCommits.map(c => `- [x] ${c}`).join('\n');
        content = content.replace(progressRegex,
          `$1${existingProgress.trimEnd()}\n${commitLines}\n${compactMarker}\n`
        );
        changed = true;
      }
    }
  }

  // If no commit changes, still add the compaction marker so we know the note was touched
  if (!changed) {
    const progressRegex = /(## Progress\s*\n)([\s\S]*?)(?=\n## |\n$)/;
    const match = content.match(progressRegex);
    if (match) {
      content = content.replace(progressRegex,
        `$1${match[2].trimEnd()}\n${compactMarker}\n`
      );
      changed = true;
    }
  }

  // Add active timer info to Context section if timers are running
  const activeTimers = run(`node "${TASKNOTES}" timer active --json`);
  if (activeTimers) {
    try {
      const timerData = JSON.parse(activeTimers);
      const sessions = timerData?.activeSessions || timerData || [];
      if (sessions.length > 0) {
        const timerLines = sessions.map(s =>
          `- Timer active: "${s.task?.title}" (${s.elapsedMinutes || 0}m elapsed)`
        ).join('\n');

        // Update or append to Context section
        const contextRegex = /(## Context\s*\n)([\s\S]*?)(?=\n## |\n$)/;
        const ctxMatch = content.match(contextRegex);
        if (ctxMatch) {
          // Remove old timer lines and add fresh ones
          let ctxBody = ctxMatch[2].replace(/- Timer active:.*\n?/g, '').trimEnd();
          content = content.replace(contextRegex, `$1${ctxBody}\n${timerLines}\n`);
          changed = true;
        }
      }
    } catch {
      // Skip
    }
  }

  if (changed) {
    fs.writeFileSync(session.filepath, content, 'utf-8');
  }

  return changed;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const cwd = process.cwd();
    const folderName = path.basename(cwd);
    const snapshot = {
      timestamp: new Date().toISOString(),
      cwd,
    };

    // Detect project
    const isInCodeDir = cwd.toLowerCase().startsWith(CODE_DIR.toLowerCase());
    if (isInCodeDir) {
      snapshot.projectName = folderName.toLowerCase() === 'workspace'
        ? 'Workspace'
        : findProjectName(folderName) || folderName;
    }

    // Get current git branch
    try {
      snapshot.branch = execSync('git rev-parse --abbrev-ref HEAD', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();
    } catch {
      // Not a git repo
    }

    // Get active vault session — UPDATE IT, then save the path for reinject
    if (snapshot.projectName && snapshot.projectName !== 'Workspace') {
      const session = findActiveSession(snapshot.projectName);
      if (session) {
        // v3: Update the session note BEFORE snapshotting
        snapshot.sessionNoteUpdated = updateSessionNote(session, cwd);
        snapshot.sessionNotePath = session.filepath;
        snapshot.sessionNoteFilename = session.filename;
      }
    }

    // Get active timers
    const activeTimers = run(`node "${TASKNOTES}" timer active --json`);
    if (activeTimers) {
      try {
        const timerData = JSON.parse(activeTimers);
        const sessions = timerData?.activeSessions || timerData || [];
        if (sessions.length > 0) {
          snapshot.activeTimers = sessions.map(s => ({
            taskTitle: s.task?.title,
            taskId: s.task?.id,
            elapsed: s.elapsedMinutes,
          }));
        }
      } catch {
        // Skip
      }
    }

    // Get in-progress tasks
    if (snapshot.projectName && snapshot.projectName !== 'Workspace') {
      const tasks = run(`node "${TASKNOTES}" list --project "${snapshot.projectName}" --json`);
      if (tasks) {
        try {
          const taskData = JSON.parse(tasks);
          const inProgress = (taskData.tasks || taskData || [])
            .filter(t => t.status === 'in-progress')
            .map(t => ({ id: t.id, title: t.title }));
          if (inProgress.length > 0) {
            snapshot.inProgressTasks = inProgress;
          }
        } catch {
          // Skip
        }
      }
    }

    // Include vault context cache if fresh (written by vault-context-prime.js at session start)
    if (fs.existsSync(CONTEXT_CACHE)) {
      try {
        const cache = JSON.parse(fs.readFileSync(CONTEXT_CACHE, 'utf8'));
        const ageMs = Date.now() - new Date(cache.timestamp).getTime();
        if (ageMs < 4 * 60 * 60 * 1000 && cache.context) {
          snapshot.vaultContext = cache.context.split('\n').slice(0, 60).join('\n');
          snapshot.vaultContextProject = cache.project;
        }
      } catch { /* skip */ }
    }

    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
