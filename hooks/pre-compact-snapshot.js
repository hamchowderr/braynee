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

const { findCodeRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

const VAULT_QUERY = path.join(__dirname, '..', 'scripts', 'vault-query.mjs');
const { getVaultRoot } = require(path.join(__dirname, '..', 'scripts', 'lib', 'vault-root.js'));
const VAULT_DIR = getVaultRoot();
const SESSIONS_DIR = path.join(VAULT_DIR, '2. Areas', 'Sessions');
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

// Find active session note for a project, returns { filename, filepath, content } or null.
// F-8.1: session notes are grouped into project subfolders
// (Sessions/<ProjectSlug>/...), so a flat readdir of SESSIONS_DIR misses them
// and compaction reinjection would restore nothing. Walk recursively, matching
// the resilient scan in session-end.js.
function findActiveSession(projectName) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  const projectSlug = projectName.replace(/[^a-zA-Z0-9]+/g, '-');

  function walkMd(dir) {
    const results = [];
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          results.push(...walkMd(path.join(dir, entry.name)));
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          results.push(path.join(dir, entry.name));
        }
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
        if (!projectMatch) continue;
        if (projectMatch[1].trim().toLowerCase() === projectName.toLowerCase()) {
          return { filename: path.basename(filepath), filepath, content };
        }
      } catch {
        continue;
      }
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
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }
    const cwd = process.cwd();
    const snapshot = {
      timestamp: new Date().toISOString(),
      cwd,
    };

    // F-3.2a + F-3.2b: detect the project from the SESSION's code root
    // (anchored at SessionStart, detected structurally) — not a ~/code prefix
    // on the transient cwd. Off ~/code this previously snapshotted no project,
    // so post-compact reinjection had nothing to restore.
    const codeRoot = findCodeRoot(sessionDir(data));
    if (codeRoot) {
      const folderName = path.basename(codeRoot);
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
