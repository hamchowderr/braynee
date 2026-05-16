// session-note-nudge.js
// Hook: PostToolUse — Reminds Claude to update the session note
// Matcher: "Write|Edit|Bash" (only after real work, not reads/greps)
//
// v3 changes:
// - Lower thresholds: every 5 tool uses OR 8 minutes
// - Output wrapped in <system-reminder> tags for reliable Claude attention
// - Goal auto-extraction: nudges Claude to fill placeholder goals
// - Recursive session lookup: searches project subfolders

const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { findCodeRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

const HOOK = 'session-note-nudge';

const VAULT_DIR = path.join(os.homedir(), 'Obsidian Vault');
const SESSIONS_DIR = path.join(VAULT_DIR, '2. Areas', 'Sessions');
const STATE_FILE = path.join(os.homedir(), '.claude', 'session-nudge-state.json');

const NUDGE_INTERVAL_TOOLS = 5;
const NUDGE_INTERVAL_MS = 8 * 60 * 1000; // 8 minutes
const NOTE_STALE_MS = 8 * 60 * 1000;

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
    } catch {
      continue;
    }
  }
  return null;
}

function findMdFiles(dir) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        results.push(...findMdFiles(path.join(dir, entry.name)));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(path.join(dir, entry.name));
      }
    }
  } catch {
    // Skip unreadable directories
  }
  return results;
}

function matchSessionFile(filepath, projectName) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');

    const statusMatch = content.match(/^status:\s*(\S+)/m);
    if (!statusMatch || statusMatch[1] !== 'active') return false;

    const projectMatch = content.match(/^project:\s*"?\[?\[?([^\]"\n]+)\]?\]?"?/m);
    if (!projectMatch) return false;

    return projectMatch[1].trim().toLowerCase() === projectName.toLowerCase();
  } catch {
    return false;
  }
}

function findActiveSessionNote(projectName) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;

  const projectSlug = projectName.replace(/[^a-zA-Z0-9]+/g, '-');
  const projectDir = path.join(SESSIONS_DIR, projectSlug);

  // Search project subfolder first
  if (fs.existsSync(projectDir)) {
    const files = findMdFiles(projectDir);
    files.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
    for (const filepath of files) {
      if (matchSessionFile(filepath, projectName)) {
        return { filename: path.basename(filepath), filepath };
      }
    }
  }

  // Fallback: scan all session files recursively
  const allFiles = findMdFiles(SESSIONS_DIR);
  allFiles.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
  for (const filepath of allFiles) {
    if (matchSessionFile(filepath, projectName)) {
      return { filename: path.basename(filepath), filepath };
    }
  }

  return null;
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {}
  return { toolCount: 0, lastNudgeTime: 0 };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
}

function checkGoalPlaceholder(session) {
  try {
    const content = fs.readFileSync(session.filepath, 'utf8');
    const goalMatch = content.match(/## Goal\s*\n([\s\S]*?)(?=\n## )/);
    const goalText = goalMatch ? goalMatch[1].trim() : '';
    const isPlaceholder = !goalText || goalText.includes('Waiting for user') || goalText === '(none yet)' || goalText === 'New session';

    if (isPlaceholder) {
      process.stdout.write(
        `<system-reminder>\n` +
        `SESSION GOAL MISSING — Extract from conversation context\n` +
        `The session note "${session.filename}" still has a placeholder Goal.\n` +
        `Review what the user has asked you to do in this session and write a clear, ` +
        `specific goal in the ## Goal section of:\n` +
        `  ${session.filepath}\n` +
        `Example: "Implement user authentication with Supabase RLS policies"\n` +
        `NOT: "Working on project" or "Code session"\n` +
        `</system-reminder>\n`
      );
    }
  } catch {
    // Don't block on goal check errors
  }
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

    // F-3.2a + F-3.2b: gate on the SESSION's code root (anchored at
    // SessionStart, detected structurally) — not process.cwd() / a ~/code
    // prefix.
    const codeRoot = findCodeRoot(sessionDir(data));
    if (!codeRoot) {
      process.exit(0);
    }
    const folderName = path.basename(codeRoot);
    if (folderName.toLowerCase() === 'workspace') {
      process.exit(0);
    }

    const projectName = findProjectName(folderName);
    if (!projectName) {
      process.exit(0);
    }

    const state = loadState();
    state.toolCount++;

    const now = Date.now();
    const timeSinceNudge = now - (state.lastNudgeTime || 0);

    const shouldNudge = state.toolCount >= NUDGE_INTERVAL_TOOLS || timeSinceNudge >= NUDGE_INTERVAL_MS;

    // Find session for both nudge and goal checks
    const session = findActiveSessionNote(projectName);

    if (shouldNudge) {
      // Reset counter
      state.toolCount = 0;
      state.lastNudgeTime = now;
      saveState(state);

      if (session) {
        const noteStat = fs.statSync(session.filepath);
        const noteAge = now - noteStat.mtime.getTime();

        if (noteAge > NOTE_STALE_MS) {
          const minutesStale = Math.round(noteAge / 60000);
          process.stdout.write(
            `<system-reminder>\n` +
            `ACTION REQUIRED — UPDATE SESSION NOTE NOW\n` +
            `Session note "${session.filename}" has not been updated in ${minutesStale} minutes.\n` +
            `Before continuing, write to the session file at:\n` +
            `  ${session.filepath}\n` +
            `Update these sections with current state:\n` +
            `  ## Decisions — any design/architecture choices made since last update\n` +
            `  ## Progress — mark completed items, add new ones\n` +
            `  ## Blockers — anything stuck or changed\n` +
            `Do this NOW before your next task. This is how context survives compaction and session restarts.\n` +
            `</system-reminder>\n`
          );
        }
      }
    } else {
      saveState(state);
    }

    // Goal check fires independently of staleness nudge
    if (session) {
      checkGoalPlaceholder(session);
    }

    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
