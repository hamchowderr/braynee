// session-note-nudge.js
// Hook: PostToolUse — Reminds Claude to update the session note
// Matcher: "Write|Edit|Bash" (only after real work, not reads/greps)
//
// Thresholds: nudge every 5 tool uses OR 8 minutes. Nudges Claude to fill a
// placeholder Goal and to refresh a stale note. Recursive session lookup
// searches project subfolders.
//
// Output goes through hookSpecificOutput.additionalContext (see emit() below) —
// NOT raw <system-reminder> stdout, which a PostToolUse hook can't surface to
// the model and which trips prompt-injection defenses (cp-30b / HD-4.1).

const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { findCodeRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

const HOOK = 'session-note-nudge';

// cp-30b / HD-4.1: a PostToolUse hook's plain stdout is NOT added to Claude's
// context — only UserPromptSubmit/SessionStart stdout is. The documented
// channel is hookSpecificOutput.additionalContext. The text must also be a
// FACTUAL statement, not an imperative "DO THIS NOW" wrapped in a fake
// <system-reminder> tag: out-of-band command phrasing trips Claude's
// prompt-injection defenses and gets shown to the user instead of acted on.
// Mirrors beads-todo-reminder.js. Multiple emits in one run are concatenated.
function emit(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
  }));
}

const { getVaultRoot } = require(path.join(__dirname, '..', 'scripts', 'lib', 'vault-root.js'));
const VAULT_DIR = getVaultRoot();
const SESSIONS_DIR = path.join(VAULT_DIR, '2. Areas', 'Sessions');
const STATE_FILE = path.join(os.homedir(), '.claude', 'session-nudge-state.json');

const NUDGE_INTERVAL_TOOLS = 5;
const NUDGE_INTERVAL_MS = 8 * 60 * 1000; // 8 minutes
const NOTE_STALE_MS = 8 * 60 * 1000;

// cp-7kfh: one shared, RECURSIVE lookup. This was a local copy that read only
// `1. Projects/*.md` and so missed every note nested in a project subfolder.
const { findProjectName: lookupProjectName } = require(path.join(__dirname, 'lib', 'vault-projects.js'));
function findProjectName(folderName) {
  return lookupProjectName(folderName, VAULT_DIR);
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
  } catch (e) {
    // Partial results are returned, so an unreadable directory silently shrinks
    // the set of session notes this nudge can see.
    log.debug(HOOK, `session-note walk failed under ${dir}: ${e && e.message}`);
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
  } catch { /* no state file yet — the caller returns documented defaults */ }
  return { toolCount: 0, lastNudgeTime: 0 };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    // Holds the tool counter and last-nudge time; a failed write makes the
    // throttle useless without any other symptom.
    log.debug(HOOK, `could not persist nudge state: ${e && e.message}`);
  }
}

// Returns a factual reminder string if the session's Goal is still a
// placeholder, else null. The caller batches this with other reminders into a
// single additionalContext emit.
function goalPlaceholderNote(session) {
  try {
    const content = fs.readFileSync(session.filepath, 'utf8');
    const goalMatch = content.match(/## Goal\s*\n([\s\S]*?)(?=\n## )/);
    const goalText = goalMatch ? goalMatch[1].trim() : '';
    const isPlaceholder = !goalText || goalText.includes('Waiting for user') || goalText === '(none yet)' || goalText === 'New session';

    if (isPlaceholder) {
      return (
        `The session note "${session.filename}" (${session.filepath}) still has a placeholder ## Goal. ` +
        `A specific goal extracted from what the user has asked this session — e.g. ` +
        `"Implement user authentication with Supabase RLS policies", not "Working on project" — ` +
        `would let the goal survive compaction and restarts.`
      );
    }
  } catch {
    // Don't block on goal check errors
  }
  return null;
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
    const notes = [];

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
          notes.push(
            `The active session note "${session.filename}" (${session.filepath}) has not been updated in ` +
            `${minutesStale} minutes. Updating ## Decisions (design/architecture choices), ## Progress ` +
            `(completed + new items), and ## Blockers with the current state keeps context recoverable ` +
            `across compaction and session restarts.`
          );
        }
      }
    } else {
      saveState(state);
    }

    // Goal check fires independently of staleness nudge.
    if (session) {
      const goalNote = goalPlaceholderNote(session);
      if (goalNote) notes.push(goalNote);
    }

    // Single additionalContext emit (concatenating multiple JSON objects on
    // stdout would be malformed).
    if (notes.length) emit(notes.join(' '));

    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
