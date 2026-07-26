// session-auto-close.js
// Hook: Stop — Snapshots progress to the active session note after every turn.
// Runs BEFORE the Haiku evaluator so the note is always up to date.
//
// What it does:
// 1. Finds active session note for current project
// 2. Reads recent git commits since `started:` and refreshes ## Progress
// 3. Auto-fills ## Goal from the JSONL transcript if still a placeholder
// 4. Writes/refreshes ## Session Summary with a `Last update:` timestamp
//
// What it deliberately does NOT do:
//   It does NOT mark the session done or write `ended:`. Stop fires after
//   every assistant turn — closing here would force SessionStart to spawn
//   a fresh empty scaffold on the very next prompt. The actual close lives
//   in session-end.js (SessionEnd hook) and the stale-session GC in
//   session-auto-track.js (SessionStart hook).

const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const { findCodeRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));
const { findTranscriptDir } = require(path.join(__dirname, 'lib', 'transcript-dir.js'));

const HOOK = 'session-auto-close';

const { getVaultRoot } = require(path.join(__dirname, '..', 'scripts', 'lib', 'vault-root.js'));
const VAULT_DIR = getVaultRoot();
const SESSIONS_DIR = path.join(VAULT_DIR, '2. Areas', 'Sessions');

// cp-7kfh: one shared, RECURSIVE lookup. This was a local copy that read only
// `1. Projects/*.md` and so missed every note nested in a project subfolder.
const { findProjectName: lookupProjectName } = require(path.join(__dirname, 'lib', 'vault-projects.js'));
function findProjectName(folderName) {
  return lookupProjectName(folderName, VAULT_DIR);
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
    } catch (e) {
      // Partial, not empty: whatever was collected before the throw is still
      // returned, so a failure here looks like "fewer session notes exist"
      // rather than an error. Record it or the shortfall is undetectable.
      log.debug(HOOK, `session-note walk failed under ${dir}: ${e && e.message}`);
    }
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
      { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }
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
      { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }
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
      encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000, windowsHide: true
    }).trim();
  } catch {
    return '';
  }
}

// Extract goal from JSONL — use the EXACT session_id passed by Claude Code,
// not whichever JSONL was most recently touched. Aggregates per project can
// span many sessions; we want this session's first prompt only.
// Delegates to the shared lib/transcript-dir helper so the cwd→transcript-dir
// encoding has a single source of truth (was duplicated inline; see cp-d9g).
function findCwdProjectsDir(cwd) {
  return findTranscriptDir(cwd);
}

function extractGoalFromJSONL(cwd, sessionId, transcriptPath) {
  try {
    let jsonlPath = null;

    // cp-wqi / HD-R1.1: Claude Code passes the conversation transcript path
    // on stdin as the documented common input field data.transcript_path
    // (guaranteed every event). Prefer it directly — this sidesteps the
    // fragile cwd→transcript-dir reconstruction (cp-d9g) and the cp-jmx
    // process.cwd() regression entirely. The reconstruction below is kept
    // as a defensive fallback for when the field is absent.
    if (typeof transcriptPath === 'string' && transcriptPath && fs.existsSync(transcriptPath)) {
      jsonlPath = transcriptPath;
    }

    let transcriptDir = null;
    if (!jsonlPath) {
      transcriptDir = findCwdProjectsDir(cwd);
      if (!transcriptDir) {
        log.info(HOOK, `goal-extract: no transcripts dir for cwd=${cwd}`);
        return null;
      }
    }

    if (!jsonlPath && sessionId) {
      const candidate = path.join(transcriptDir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) jsonlPath = candidate;
    }
    if (!jsonlPath) {
      // Fallback: most-recently-modified jsonl (legacy behavior)
      const candidates = fs.readdirSync(transcriptDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(transcriptDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (candidates.length === 0) return null;
      jsonlPath = path.join(transcriptDir, candidates[0].name);
      log.warn(HOOK, `goal-extract: no session_id, falling back to ${candidates[0].name}`);
    }

    const raw = fs.readFileSync(jsonlPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        // Only accept user messages from THIS session (not aggregated history).
        // Each line in the JSONL has a top-level sessionId field.
        if (sessionId && obj.sessionId && obj.sessionId !== sessionId) continue;
        if (obj.type !== 'user' || obj.isMeta === true) continue;
        let msg = '';
        if (typeof obj.message?.content === 'string') {
          msg = obj.message.content;
        } else if (Array.isArray(obj.message?.content)) {
          msg = obj.message.content.filter(c => c.type === 'text').map(c => c.text).join(' ');
        }
        msg = msg.replace(/<[^>]+>/g, '').trim();
        if (msg.length > 15 && !msg.startsWith('/') && !msg.includes('command-name')) {
          const goal = msg.substring(0, 200);
          return goal.length > 120 ? goal.substring(0, 117) + '...' : goal;
        }
      } catch { continue; }
    }
    return null;
  } catch (err) {
    log.error(HOOK, `goal-extract failed: ${err.message}`);
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
  let sessionId = null;
  try {
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }
    sessionId = data.session_id || null;

    // F-3.2a + F-3.2b: resolve the SESSION's code root (anchored at
    // SessionStart, detected structurally) — not a ~/code prefix on the
    // transient cwd. Off ~/code this previously never closed the session note.
    const codeRoot = findCodeRoot(sessionDir(data));
    const folderName = codeRoot ? path.basename(codeRoot) : null;

    log.info(HOOK, `start cwd=${folderName || '(not code)'} session=${sessionId || 'unknown'}`);

    if (!codeRoot || folderName.toLowerCase() === 'workspace') {
      log.info(HOOK, `skip: not a code session`);
      process.exit(0);
    }

    const projectName = findProjectName(folderName);
    if (!projectName) {
      log.warn(HOOK, `no project file in vault for folder "${folderName}" — session won't be closed. Run /braynee:project-onboarder or create 1. Projects/<name>.md with folder: ${folderName}`);
      process.exit(0);
    }

    const session = findActiveSession(projectName);
    if (!session) {
      log.info(HOOK, `no active session for ${projectName} — nothing to close`);
      process.exit(0);
    }

    log.info(HOOK, `closing session ${session.filename} for ${projectName}`);

    let content = session.content;
    const now = new Date().toISOString();

    // Extract started time for duration calc and commit scoping
    const startedMatch = content.match(/^started:\s*(.+)/m);
    const startedIso = startedMatch ? startedMatch[1].trim() : null;
    const duration = startedMatch ? getSessionDuration(startedIso) : 'unknown';

    // Get git data scoped to this session window (run at the project repo
    // root — the detected code root — not a possibly-nested transient cwd).
    const commits = getRecentCommits(codeRoot, startedIso);
    const filesChanged = getFilesChanged(codeRoot);
    const branch = getBranch(codeRoot);

    // ─── Auto-fill Goal if still a placeholder ──────────────────────
    const goalMatch = content.match(/## Goal\s*\n([\s\S]*?)(?=\n## )/);
    const goalText = goalMatch ? goalMatch[1].trim() : '';
    const goalIsPlaceholder = !goalText ||
      goalText.includes('Waiting for user') ||
      goalText === '(none yet)' ||
      goalText.startsWith('(session just');

    if (goalIsPlaceholder) {
      // cp-wqi / HD-R1.1: prefer the documented data.transcript_path from
      // stdin; fall back to the anchored session dir (NOT process.cwd(),
      // which was the cp-jmx regression — the transient per-event cwd is
      // flipped by skill base dirs / `bash cd`).
      const extracted = extractGoalFromJSONL(sessionDir(data), sessionId, data.transcript_path);
      if (extracted) {
        log.info(HOOK, `goal extracted (${extracted.length} chars)`);
        content = content.replace(
          /## Goal\s*\n[\s\S]*?(?=\n## )/,
          `## Goal\n${extracted} *(auto-extracted from session)*\n`
        );
      } else {
        log.warn(HOOK, `goal still placeholder — extraction returned nothing`);
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
    summaryParts.push(`Last update: ${now}`);

    const summaryBlock = `## Session Summary\n${summaryParts.join('\n')}\n`;

    // Replace existing summary or append
    if (content.includes('## Session Summary')) {
      content = content.replace(/## Session Summary[\s\S]*$/, summaryBlock);
    } else {
      content = content.trimEnd() + '\n\n' + summaryBlock;
    }

    // ─── Frontmatter touch-ups (handle CRLF on Windows) ─────────────
    // Do NOT flip status or write `ended:` here — Stop fires on every turn.
    // The actual close lives in session-end.js (SessionEnd) and the stale GC
    // in session-auto-track.js (SessionStart).
    content = content.replace(/\r\n/g, '\n');
    if (branch) {
      content = content.replace(/^branch:\s*".*"/m, `branch: "${branch}"`);
    }

    // Write
    fs.writeFileSync(session.filepath, content, 'utf-8');
    log.info(HOOK, `snapshot ${session.filename} (commits=${commits.length}, duration=${duration})`);

    process.stderr.write(
      `Session note snapshot: ${session.filename}\n` +
      `  Duration: ${duration}, Commits: ${commits.length}, Branch: ${branch}`
    );

    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message} at ${e.stack?.split('\n')[1]?.trim() || ''}`);
    // Don't block stop
    process.exit(0);
  }
});
