// statusline-state.js
// Hook: PostToolUse (async) — writes live context for statusline display
// Matcher: "Write|Edit|Bash"
// async: true — never blocks Claude, runs in background after tool use
//
// Writes ~/.claude/statusline-live.json with:
//   - goal: first line of active session's ## Goal
//   - project: current project name
//   - beads: open/ready counts from the project's .beads/
//
// Statusline reads this file instantly on every render.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { findCodeRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

const { getVaultRoot } = require(path.join(__dirname, '..', 'scripts', 'lib', 'vault-root.js'));
const VAULT_DIR = getVaultRoot();
const SESSIONS_DIR = path.join(VAULT_DIR, '2. Areas', 'Sessions');
const STATE_FILE = path.join(os.homedir(), '.claude', 'statusline-live.json');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const HOOK = 'statusline-state';

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
    // Partial results are returned; the statusline then shows no session
    // rather than reporting that it could not read them.
    log.debug(HOOK, `session-note walk failed under ${dir}: ${e && e.message}`);
  }
  return results;
}

function findActiveSession(projectName) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  const projectSlug = projectName.replace(/[^a-zA-Z0-9]+/g, '-');
  const projectDir = path.join(SESSIONS_DIR, projectSlug);
  const seen = new Set();
  for (const searchDir of [projectDir, SESSIONS_DIR].filter(d => fs.existsSync(d))) {
    const files = findMdFiles(searchDir).filter(f => !seen.has(f));
    files.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
    for (const filepath of files) {
      seen.add(filepath);
      try {
        const content = fs.readFileSync(filepath, 'utf8');
        const statusMatch = content.match(/^status:\s*(\S+)/m);
        if (!statusMatch || statusMatch[1] !== 'active') continue;
        const projectMatch = content.match(/^project:\s*"?\[?\[?([^\]"\n]+)\]?\]?"?/m);
        if (!projectMatch) continue;
        if (projectMatch[1].trim().toLowerCase() === projectName.toLowerCase()) {
          return { filepath, content, filename: path.basename(filepath) };
        }
      } catch { continue; }
    }
  }
  return null;
}

function extractGoal(content) {
  const goalMatch = content.match(/## Goal\s*\n([\s\S]*?)(?=\n## )/);
  if (!goalMatch) return '';
  const text = goalMatch[1].trim();
  if (!text || text.match(/^\(none|^\(waiting|^\(session just/i)) return '';
  const firstLine = text.split('\n').find(l => l.trim()) || '';
  return firstLine.replace(/^[-*#]\s*/, '').trim().substring(0, 120);
}

// Read open/ready counts straight from the project's .beads/issues.jsonl — the
// source of truth. NO `bd`, NO server, NO process spawn.
//
// WHY (cp-6j5 / dolt-guard): this used to run `bd` 3× on EVERY Write/Edit/Bash.
// When the shared Dolt server is wedged, each `bd` makes bd auto-start a new dolt
// sql-server, and "3× per tool" floods the machine with hundreds of them until it
// crashes. A status bar never needs a live DB query — the JSONL is right there.
function getBeadsData(projectDir) {
  try {
    const jsonl = path.join(projectDir, '.beads', 'issues.jsonl');
    if (!fs.existsSync(jsonl)) return null;
    let openCount = 0;
    let readyCount = 0;
    for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let issue;
      try { issue = JSON.parse(s); } catch { continue; }
      const status = issue && issue.status;
      if (!status || status === 'closed') continue;
      openCount++;
      // "ready" ≈ actionable now: open (not in_progress / blocked / deferred).
      // A cheap, server-free approximation — good enough for a status bar.
      if (status === 'open') readyCount++;
    }
    if (!openCount && !readyCount) return null;
    return { openCount, readyCount };
  } catch {
    return null;
  }
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;

  try {
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }

    // F-3.2a + F-3.2b: gate on the SESSION's code root (anchored at
    // SessionStart, detected structurally) — not a ~/code prefix on the
    // transient cwd.
    const codeRoot = findCodeRoot(sessionDir(data));
    if (!codeRoot) process.exit(0);
    const folderName = path.basename(codeRoot);
    if (folderName.toLowerCase() === 'workspace') {
      process.exit(0);
    }

    const projectName = findProjectName(folderName);
    if (!projectName) process.exit(0);

    const session = findActiveSession(projectName);
    const goal = session ? extractGoal(session.content) : '';
    const beads = getBeadsData(codeRoot); // synchronous JSONL read — no bd, no spawn

    const state = {
      goal,
      project: projectName,
      cwd: codeRoot,
      sessionFile: session?.filename || '',
      beads,
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    process.exit(0);
  } catch {
    process.exit(0);
  }
}

main();
