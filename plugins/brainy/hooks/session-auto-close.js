// session-auto-close.js
// Hook: Stop — Automatically updates and closes the active session note
// Runs BEFORE the Haiku evaluator so the note is always written
//
// What it does:
// 1. Finds active session note for current project
// 2. Reads recent git commits to build a progress summary
// 3. Updates ## Progress with commit history
// 4. Adds ## Session Summary
// 5. Sets status: done, ended: timestamp
//
// This guarantees the session note is always up-to-date for next-day pickup,
// even if Claude forgets, gets interrupted, or stop hooks time out.

const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const VAULT_DIR = path.join(os.homedir(), 'Obsidian Vault');
const SESSIONS_DIR = path.join(VAULT_DIR, '2. Areas', 'Sessions');
const CODE_DIR = path.join(os.homedir(), 'code');

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

function findActiveSession(projectName) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;

  const projectSlug = projectName.replace(/[^a-zA-Z0-9]+/g, '-');
  const projectDir = path.join(SESSIONS_DIR, projectSlug);

  // Recursive file finder
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
    } catch {}
    return results;
  }

  // Search project subfolder first, then all of Sessions/
  const searchDirs = [];
  if (fs.existsSync(projectDir)) searchDirs.push(projectDir);
  searchDirs.push(SESSIONS_DIR);

  const searched = new Set();
  for (const searchDir of searchDirs) {
    const files = findMdFiles(searchDir);
    // Sort newest first by filename (date-prefixed)
    files.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));

    for (const filepath of files) {
      if (searched.has(filepath)) continue;
      searched.add(filepath);

      try {
        const content = fs.readFileSync(filepath, 'utf8');
        const statusMatch = content.match(/^status:\s*(\S+)/m);
        if (!statusMatch || statusMatch[1] !== 'active') continue;
        const projectMatch = content.match(/^project:\s*"?\[?\[?([^\]"\n]+)\]?\]?"?/m);
        if (!projectMatch) continue;
        if (projectMatch[1].trim().toLowerCase() === projectName.toLowerCase()) {
          return { filename: path.basename(filepath), filepath, content };
        }
      } catch { continue; }
    }
  }
  return null;
}

function getRecentCommits(cwd, sinceIso) {
  try {
    // Scope commits to the session window using started timestamp
    const sinceFlag = sinceIso ? '--after="' + sinceIso + '"' : '--since="24 hours ago"';
    const log = execSync(
      'git log --all --oneline ' + sinceFlag + ' --no-merges --format="%h %s"',
      { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 }
    ).trim();
    if (!log) return [];
    return log.split('\n').filter(Boolean).slice(0, 15);
  } catch {
    return [];
  }
}

function getFilesChanged(cwd) {
  try {
    const diff = execSync(
      'git diff --stat HEAD~10 HEAD --no-merges 2>nul || git diff --stat --cached',
      { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 }
    ).trim();
    // Just get the summary line (e.g., "15 files changed, 500 insertions(+), 20 deletions(-)")
    const lines = diff.split('\n');
    return lines[lines.length - 1] || '';
  } catch {
    return '';
  }
}

function getBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000
    }).trim();
  } catch {
    return '';
  }
}

// Extract goal from JSONL when session note still has placeholder
function extractGoalFromJSONL(folderName) {
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    const patterns = [
      `C--Users-HamCh-code-${folderName}`,
      `C--Users-HamCh-${folderName}`,
    ];
    let transcriptDir = null;
    for (const pattern of patterns) {
      const dir = path.join(projectsDir, pattern);
      if (fs.existsSync(dir)) { transcriptDir = dir; break; }
    }
    if (!transcriptDir) return null;

    const jsonlFiles = fs.readdirSync(transcriptDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(transcriptDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
    if (jsonlFiles.length === 0) return null;

    const raw = fs.readFileSync(path.join(transcriptDir, jsonlFiles[0].name), 'utf8');
    const lines = raw.split('\n').filter(Boolean);

    const userMessages = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user' && obj.isMeta !== true) {
          let msg = '';
          if (typeof obj.message?.content === 'string') {
            msg = obj.message.content;
          } else if (Array.isArray(obj.message?.content)) {
            msg = obj.message.content.filter(c => c.type === 'text').map(c => c.text).join(' ');
          }
          msg = msg.replace(/<[^>]+>/g, '').trim();
          if (msg.length > 15 && !msg.startsWith('/') && !msg.includes('command-name')) {
            userMessages.push(msg.substring(0, 200));
            if (userMessages.length >= 2) break;
          }
        }
      } catch { continue; }
    }

    if (userMessages.length === 0) return null;
    const goal = userMessages[0];
    return goal.length > 120 ? goal.substring(0, 117) + '...' : goal;
  } catch {
    return null;
  }
}

function getSessionDuration(startedIso) {
  if (!startedIso) return 'unknown';
  const start = new Date(startedIso);
  const now = new Date();
  const diffMs = now - start;
  const hours = Math.floor(diffMs / 3600000);
  const minutes = Math.floor((diffMs % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ─── Main ────────────────────────────────────────────────────────────────────
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const cwd = process.cwd();
    const folderName = path.basename(cwd);
    const isInCodeDir = cwd.toLowerCase().startsWith(CODE_DIR.toLowerCase());

    if (!isInCodeDir || folderName.toLowerCase() === 'workspace') {
      process.exit(0);
    }

    const projectName = findProjectName(folderName);
    if (!projectName) {
      process.exit(0);
    }

    const session = findActiveSession(projectName);
    if (!session) {
      // No active session — nothing to close
      process.exit(0);
    }

    let content = session.content;
    const now = new Date().toISOString();

    // Extract started time for duration calc and commit scoping
    const startedMatch = content.match(/^started:\s*(.+)/m);
    const startedIso = startedMatch ? startedMatch[1].trim() : null;
    const duration = startedMatch ? getSessionDuration(startedIso) : 'unknown';

    // Get git data scoped to this session window
    const commits = getRecentCommits(cwd, startedIso);
    const filesChanged = getFilesChanged(cwd);
    const branch = getBranch(cwd);

    // ─── Auto-fill Goal if still a placeholder ──────────────────────
    const goalMatch = content.match(/## Goal\s*\n([\s\S]*?)(?=\n## )/);
    const goalText = goalMatch ? goalMatch[1].trim() : '';
    const goalIsPlaceholder = !goalText ||
      goalText.includes('Waiting for user') ||
      goalText === '(none yet)' ||
      goalText.startsWith('(session just');

    if (goalIsPlaceholder) {
      const extracted = extractGoalFromJSONL(folderName);
      if (extracted) {
        content = content.replace(
          /## Goal\s*\n[\s\S]*?(?=\n## )/,
          `## Goal\n${extracted} *(auto-extracted from session)*\n`
        );
      }
    }

    // ─── Build progress from commits ───────────────────────────────
    if (commits.length > 0) {
      const progressLines = commits.map(c => `- [x] ${c}`);

      // Replace ## Progress section
      const progressRegex = /(## Progress\s*\n)([\s\S]*?)(?=\n## |\n$)/;
      if (progressRegex.test(content)) {
        content = content.replace(progressRegex, `$1${progressLines.join('\n')}\n`);
      }
    }

    // ─── Add/update Session Summary ───────────────────────────────
    const summaryParts = [];
    summaryParts.push(`Session duration: ${duration}`);
    if (branch) summaryParts.push(`Branch: \`${branch}\``);
    if (commits.length > 0) summaryParts.push(`Commits: ${commits.length}`);
    if (filesChanged) summaryParts.push(`Changes: ${filesChanged}`);
    summaryParts.push('');
    if (commits.length > 0) {
      summaryParts.push('Work completed:');
      for (const c of commits) {
        summaryParts.push(`- ${c}`);
      }
    }
    summaryParts.push('');
    summaryParts.push(`Closed: ${now}`);

    const summaryBlock = `## Session Summary\n${summaryParts.join('\n')}\n`;

    // Replace existing summary or append
    if (content.includes('## Session Summary')) {
      content = content.replace(/## Session Summary[\s\S]*$/, summaryBlock);
    } else {
      content = content.trimEnd() + '\n\n' + summaryBlock;
    }

    // ─── Update frontmatter (handle CRLF on Windows) ─────────────
    content = content.replace(/\r\n/g, '\n');
    content = content.replace(/^status:\s*active\s*$/m, 'status: done');
    content = content.replace(/^ended:\s*null\s*$/m, `ended: ${now}`);
    // Ensure ended field exists if not present
    if (!/^ended:/m.test(content)) {
      content = content.replace(/^(started:\s*[^\n]+)/m, `$1\nended: ${now}`);
    }
    if (branch) {
      content = content.replace(/^branch:\s*".*"/m, `branch: "${branch}"`);
    }

    // Write
    fs.writeFileSync(session.filepath, content, 'utf-8');

    // Clean up nudge state so next session starts fresh
    const nudgeState = path.join(os.homedir(), '.claude', 'session-nudge-state.json');
    try { fs.unlinkSync(nudgeState); } catch {}

    process.stderr.write(
      `Session note auto-closed: ${session.filename}\n` +
      `  Duration: ${duration}, Commits: ${commits.length}, Branch: ${branch}`
    );

    process.exit(0);
  } catch (e) {
    // Don't block stop
    process.exit(0);
  }
});
