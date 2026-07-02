// session-auto-track.js
// Hook: Automatically loads vault context, creates/resumes sessions on SessionStart
// Matcher: "" (all session starts, not just compact)
// Input: JSON on stdin from Claude Code (includes session_id, cwd, etc.)
// Output: stdout message gets injected into the conversation
//
// v2 changes:
// - Auto-creates session note if none exists (instead of just reminding)
// - Injects active session note CONTENT into context (not just metadata)
// - Detects git branch for auto-created sessions

const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { findSessionViaQmd } = require('./lib/qmd-search');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { findCodeRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));
const { isIgnoredFolder } = require(path.join(__dirname, 'lib', 'ignore-folders.js'));
const { findTranscriptDir } = require(path.join(__dirname, 'lib', 'transcript-dir.js'));

const HOOK = 'session-auto-track';

const PLUGIN_ROOT = path.join(__dirname, '..');
const VAULT_QUERY = path.join(PLUGIN_ROOT, 'scripts', 'vault-query.mjs');
const { getVaultRoot } = require(path.join(__dirname, '..', 'scripts', 'lib', 'vault-root.js'));
const VAULT_DIR = getVaultRoot();
const SESSIONS_DIR = path.join(VAULT_DIR, '2. Areas', 'Sessions');
const PRD_DIR = path.join(VAULT_DIR, '2. Areas', 'Product Manager', 'PRDs');

function findPrdForFolder(folderName) {
  if (!fs.existsSync(PRD_DIR)) return null;
  function walk(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_')) out.push(p);
    }
    return out;
  }
  for (const file of walk(PRD_DIR)) {
    try {
      const content = fs.readFileSync(file, 'utf-8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;
      const fm = {};
      for (const line of fmMatch[1].split('\n')) {
        const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
        if (kv) {
          let v = kv[2].trim().replace(/^["'](.*)["']$/, '$1');
          if (v === 'true') v = true;
          else if (v === 'false') v = false;
          else if (/^\d+$/.test(v)) v = parseInt(v);
          fm[kv[1]] = v;
        }
      }
      if (fm.type !== 'prd') continue;
      if ((fm.folder || '').toLowerCase() !== folderName.toLowerCase()) continue;
      const body = content.slice(fmMatch[0].length);
      const acMatch = body.match(/##\s+Acceptance Criteria\s*\n([\s\S]*?)(?=\n##\s+|\n*$)/i);
      const acceptanceCount = acMatch
        ? acMatch[1].split('\n').filter(l => /^\s*-\s+\[\s\]\s+\*\*\[P[0-3]\]/.test(l)).length
        : 0;
      return { fm, acceptanceCount, relPath: path.relative(VAULT_DIR, file) };
    } catch { continue; }
  }
  return null;
}

function findProjectName(folderName) {
  const projectsDir = path.join(VAULT_DIR, '1. Projects');
  if (!fs.existsSync(projectsDir)) return null;

  // Recurse into project subfolders, not just top-level *.md. The PARA
  // convention puts multi-note projects in their own folder with the main note
  // inside (1. Projects/<Name>/<Name>.md). A flat readdirSync missed those, so
  // findProjectName returned null and the caller auto-created a duplicate flat
  // file every session (cp-31i; same class as the recursive-audit memory).
  // Match on the `folder:` frontmatter exactly as before — first match wins.
  for (const filepath of walkMdFiles(projectsDir)) {
    try {
      const content = fs.readFileSync(filepath, 'utf8');
      const folderMatch = content.match(/^folder:\s*"?([^"\n]+)"?$/m);
      if (folderMatch && folderMatch[1].trim().toLowerCase() === folderName.toLowerCase()) {
        const nameMatch = content.match(/^name:\s*"?([^"\n]+)"?$/m);
        if (nameMatch) return nameMatch[1].trim();
        return path.basename(filepath).replace(/\.md$/, '');
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

// Convert "foreman" → "Foreman", "ncat-mcp" → "NCAT MCP"
function folderNameToTitle(folder) {
  // ALL CAPS acronyms (3-4 chars) get uppercased; otherwise titlecase each part
  return folder
    .split(/[-_\s]+/)
    .map(part => {
      if (!part) return '';
      if (part.length <= 4 && part.toLowerCase() === part) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

// Auto-create a minimal 1. Projects/<Name>.md so session tracking works.
// Returns the project name, or null on failure.
function autoCreateProjectFile(folderName) {
  try {
    const projectsDir = path.join(VAULT_DIR, '1. Projects');
    if (!fs.existsSync(projectsDir)) return null;

    const projectName = folderNameToTitle(folderName);
    const fileName = `${projectName}.md`;
    const filePath = path.join(projectsDir, fileName);

    // Don't overwrite if it exists with a different folder mapping
    if (fs.existsSync(filePath)) {
      log.warn(HOOK, `auto-create skipped: ${fileName} exists but folder field doesn't match "${folderName}"`);
      return null;
    }

    // Safety net (cp-31i): a folder-layout note (1. Projects/<Name>/<Name>.md)
    // lives in a subfolder, so the flat filePath check above never sees it.
    // findProjectName should already have resolved it, but if we got here a
    // nested note still represents this folder — don't write a flat duplicate.
    const nestedPath = path.join(projectsDir, projectName, `${projectName}.md`);
    if (fs.existsSync(nestedPath)) {
      log.warn(HOOK, `auto-create skipped: nested ${projectName}/${projectName}.md already exists for folder "${folderName}"`);
      return null;
    }

    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const body = [
      '---',
      `name: "${projectName}"`,
      `folder: "${folderName}"`,
      'status: active',
      'category: product',
      'tags: [project, auto-created]',
      `created: ${today}`,
      `description: "Auto-created by braynee session-auto-track. Update with real description."`,
      '---',
      '',
      `# ${projectName}`,
      '',
      '> Auto-created by braynee on first session in this folder. Replace this with a real project description.',
      '',
      '## Status',
      'active',
      '',
      '## Goal',
      '*(none yet — set when you know what this project is for)*',
      '',
      '## Architecture',
      '*(to fill in)*',
      '',
      '## Decisions',
      '*(none yet)*',
      '',
      '## Sessions',
      '`= "[[" + this.file.path.replace(".md", "") + "]]"`',
      '',
    ].join('\n');

    fs.writeFileSync(filePath, body, 'utf8');
    log.info(HOOK, `auto-created project file: ${fileName} (folder=${folderName})`);
    return projectName;
  } catch (err) {
    log.error(HOOK, `auto-create project failed: ${err.message}`);
    return null;
  }
}

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
  } catch (e) {
    return null;
  }
}

function getGitBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

// Check if a session file is an active session for the given project
// Returns { filename, filepath, content, relPath } or null
function checkSessionFile(filepath, projectName) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');

    // Check status: active
    const statusMatch = content.match(/^status:\s*(\S+)/m);
    if (!statusMatch || statusMatch[1] !== 'active') return null;

    // Check project matches
    const projectMatch = content.match(/^project:\s*"?\[?\[?([^\]"\n]+)\]?\]?"?/m);
    if (!projectMatch) return null;

    const noteProject = projectMatch[1].trim();
    if (noteProject.toLowerCase() !== projectName.toLowerCase()) return null;

    const filename = path.basename(filepath);
    // Compute relative path from SESSIONS_DIR for display
    const relPath = path.relative(SESSIONS_DIR, filepath).replace(/\\/g, '/');
    return { filename, filepath, content, relPath };
  } catch {
    return null;
  }
}

// Recursively collect .md files from a directory
function walkMdFiles(dir) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        results.push(...walkMdFiles(path.join(dir, entry.name)));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(path.join(dir, entry.name));
      }
    }
  } catch {
    // Ignore permission errors etc.
  }
  return results;
}

// Global reconciliation: close any `status: active` session note whose last
// activity (file mtime) is older than STALE_HOURS, regardless of project.
// Claude Code does not fire SessionEnd on crashes / killed windows, and the
// per-project GC below only ever inspected the CURRENT project's session —
// so abandoned sessions in projects you don't revisit stayed `active`
// forever (cp-re1). mtime is the right signal: a long but live session is
// kept fresh by the Stop-hook note updates, so it is never swept; only a
// session with no writes for STALE_HOURS is treated as abandoned.
function sweepStaleActiveSessions(staleHours) {
  const result = { closed: 0, names: [] };
  if (!fs.existsSync(SESSIONS_DIR)) return result;
  const cutoffMs = Date.now() - staleHours * 3600000;
  for (const filepath of walkMdFiles(SESSIONS_DIR)) {
    try {
      const st = fs.statSync(filepath);
      if (st.mtimeMs >= cutoffMs) continue; // recent activity — leave it
      const content = fs.readFileSync(filepath, 'utf8');
      // Only touch session notes that are still flagged active.
      if (!/^status:\s*active\s*$/m.test(content)) continue;
      if (!/^started:\s*/m.test(content)) continue; // sanity: it's a session note
      const endedIso = new Date(st.mtimeMs).toISOString();
      let closed = content.replace(/\r\n/g, '\n');
      closed = closed.replace(/^status:\s*active\s*$/m, 'status: done');
      closed = closed.replace(/^ended:\s*null\s*$/m, `ended: ${endedIso}`);
      if (!/^ended:/m.test(closed)) {
        closed = closed.replace(/^(started:\s*[^\n]+)/m, `$1\nended: ${endedIso}`);
      }
      fs.writeFileSync(filepath, closed, 'utf-8');
      result.closed++;
      result.names.push(path.basename(filepath, '.md'));
    } catch (e) {
      log.warn(HOOK, `stale-sweep skip ${path.basename(filepath)}: ${e.message}`);
    }
  }
  if (result.closed > 0) {
    log.info(HOOK, `reconciled ${result.closed} abandoned session(s): ${result.names.join(', ')}`);
  }
  return result;
}

// Find active session note for a project, returns { filename, filepath, content, relPath } or null
function findActiveSession(projectName) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;

  const projectSlug = projectName.replace(/[^a-zA-Z0-9]+/g, '-');
  const projectDir = path.join(SESSIONS_DIR, projectSlug);

  // ─── Try QMD first (fast semantic search) ────────────────────────
  try {
    const qmdPath = findSessionViaQmd(projectName);
    if (qmdPath) {
      // Normalize: QMD may return vault-relative or absolute path
      let absPath = qmdPath;
      if (!path.isAbsolute(absPath)) {
        absPath = path.join(VAULT_DIR, absPath);
      }
      if (fs.existsSync(absPath)) {
        const result = checkSessionFile(absPath, projectName);
        if (result) return result;
      }
    }
  } catch {
    // QMD unavailable — fall through to filesystem
  }

  // ─── Try project subfolder (fast path) ───────────────────────────
  if (fs.existsSync(projectDir)) {
    const files = walkMdFiles(projectDir);
    files.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
    for (const filepath of files) {
      const result = checkSessionFile(filepath, projectName);
      if (result) return result;
    }
  }

  // ─── Fallback: scan all of SESSIONS_DIR (backwards compat) ──────
  const seenDirs = new Set();
  if (fs.existsSync(projectDir)) seenDirs.add(projectDir.toLowerCase());

  const allFiles = walkMdFiles(SESSIONS_DIR).filter(f => {
    // Skip files already checked in projectDir
    const dir = path.dirname(f).toLowerCase();
    return !seenDirs.has(dir);
  });
  allFiles.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));

  for (const filepath of allFiles) {
    const result = checkSessionFile(filepath, projectName);
    if (result) return result;
  }

  return null;
}

// Auto-create a session note, returns { filename, filepath, content, relPath }
// sessionId is stamped into the frontmatter so the claude -p distiller
// (skills/session-backfill/scripts/backfill.py) can later find THIS stub by
// session_id and upgrade its hollow body in place — instead of writing a
// second, parallel note. Without it the stub and the distilled note diverge
// (duplication + folder drift). See beads: hollow-stub coordination bug.
function createSession(projectName, branch, sessionId) {
  // Create project subfolder
  const projectSlug = projectName.replace(/[^a-zA-Z0-9]+/g, '-');
  const projectDir = path.join(SESSIONS_DIR, projectSlug);
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const type = 'code';

  // Handle filename collisions
  let filename = `${date}-${slug}-${type}.md`;
  let counter = 2;
  while (fs.existsSync(path.join(projectDir, filename))) {
    filename = `${date}-${slug}-${type}-${counter}.md`;
    counter++;
  }

  const filepath = path.join(projectDir, filename);
  const isoNow = now.toISOString();

  const content = `---
type: session
project: "[[${projectName}]]"
status: active
session_type: ${type}
session_id: "${sessionId || ''}"
branch: "${branch || ''}"
started: ${isoNow}
ended: null
tags:
  - session
  - ${type}
---

## Goal
(Waiting for user to state goal — update this when the session objective becomes clear)

## Context
- Working on [[${projectName}]]
${branch ? `- Branch: \`${branch}\`` : ''}
- Auto-created at session start

## Decisions
- (none yet)

## Progress
- (session just started)

## Blockers
- (none)
`;

  fs.writeFileSync(filepath, content, 'utf-8');
  const relPath = projectSlug + '/' + filename;
  return { filename, filepath, content, relPath };
}

// Extract the useful parts of a session note for context injection
function formatSessionContext(content, filename) {
  const lines = [];
  lines.push(`── ACTIVE SESSION: ${filename} ──`);

  // Extract each section we care about
  const sections = ['Goal', 'Decisions', 'Progress', 'Blockers', 'Context'];
  for (const section of sections) {
    const regex = new RegExp(`## ${section}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
    const match = content.match(regex);
    if (match) {
      const body = match[1].trim();
      // Skip sections that are just placeholders
      if (body && !body.match(/^\(none|^\(waiting|^\(session just/i)) {
        lines.push(`[${section}]`);
        // Cap each section at 10 lines
        const sectionLines = body.split('\n').slice(0, 10);
        lines.push(...sectionLines);
        if (body.split('\n').length > 10) lines.push('  ...');
        lines.push('');
      }
    }
  }

  lines.push('── END SESSION NOTE ──');
  return lines.join('\n');
}

// Find the most recent JSONL transcript for the SESSION's actual cwd.
// Derives the transcript dir by encoding `cwd` via the shared
// lib/transcript-dir helper — NOT a hardcoded C--Users-<user>-code-<folder>
// string, which only worked for one machine (one username + repos under
// ~/code). For any other user, a non-~/code project location, or a
// differently-cased path, the old hardcode missed the dir entirely and no
// prior-session context was ever recalled (cp-d9g / S-1).
function getRecentTranscriptContext(cwd, transcriptPath) {
  let latestFile = null;
  let sessionId = null;

  // cp-wqi / HD-R1.1: Claude Code passes the conversation transcript path
  // on stdin as the documented common input field data.transcript_path
  // (guaranteed every event). Prefer it directly when present — sidesteps
  // the fragile cwd→transcript-dir reconstruction (cp-d9g). The directory
  // scan below is kept as a defensive fallback for when the field is absent.
  if (typeof transcriptPath === 'string' && transcriptPath && fs.existsSync(transcriptPath)) {
    latestFile = transcriptPath;
    sessionId = path.basename(transcriptPath).replace(/\.jsonl$/, '');
  }

  if (!latestFile) {
    const transcriptDir = findTranscriptDir(cwd);
    if (!transcriptDir) return null;

    // Find most recent JSONL file
    const jsonlFiles = fs.readdirSync(transcriptDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(transcriptDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);

    if (jsonlFiles.length === 0) return null;

    latestFile = path.join(transcriptDir, jsonlFiles[0].name);
    sessionId = jsonlFiles[0].name.replace('.jsonl', '');
  }

  // Read last ~100KB of the file (tail read for large files)
  const stat = fs.statSync(latestFile);
  const readSize = Math.min(stat.size, 100 * 1024);
  const fd = fs.openSync(latestFile, 'r');
  const buffer = Buffer.alloc(readSize);
  fs.readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
  fs.closeSync(fd);

  const tail = buffer.toString('utf8');
  const lines = tail.split('\n').filter(Boolean);

  // Extract user messages (non-meta, non-command)
  const userMessages = [];
  let slug = null;
  let lastTimestamp = null;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.slug) slug = obj.slug;
      if (obj.timestamp) lastTimestamp = obj.timestamp;

      if (obj.type === 'user' && obj.isMeta !== true) {
        let content = '';
        if (typeof obj.message?.content === 'string') {
          content = obj.message.content;
        } else if (Array.isArray(obj.message?.content)) {
          content = obj.message.content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join(' ');
        }

        // Skip noise
        content = content.replace(/<[^>]+>/g, '').trim();
        if (content.length > 10 && !content.startsWith('/') && !content.includes('command-name')) {
          userMessages.push(content.substring(0, 200));
        }
      }
    } catch {
      continue;
    }
  }

  if (userMessages.length === 0) return null;

  return {
    sessionId,
    slug,
    lastTimestamp,
    // Last 5 meaningful user messages from most recent session
    recentMessages: userMessages.slice(-5),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }
    const eventCwd = data.cwd || process.cwd();
    const sessionId = data.session_id || null;

    // Normalize paths to forward slashes for consistent comparison on Windows
    const norm = (p) => p.toLowerCase().replace(/\\/g, '/');

    // This hook INTENTIONALLY runs in three modes — code, vault, workspace —
    // (see the `if (!isInCodeDir && !isWorkspace && !isVault)` guard below). We
    // only universalize the *code* detection: F-3.2a + F-3.2b replace the
    // ~/code prefix with a structural code-context check on the SESSION's
    // working dir (anchored at SessionStart). The vault check stays a real
    // VAULT_DIR path test (not a ~/code assumption) and is left as-is.
    const codeRoot = findCodeRoot(sessionDir(data));
    const isInCodeDir = codeRoot !== null;
    // In code mode, derive the project folder + git cwd from the detected
    // code root, not a possibly-nested transient cwd.
    const cwd = codeRoot || eventCwd;
    const folderName = path.basename(cwd);
    const isWorkspace = folderName.toLowerCase() === 'workspace';
    const isVault = norm(eventCwd).startsWith(norm(VAULT_DIR));

    log.info(HOOK, `start cwd=${folderName} session=${sessionId || 'unknown'} mode=${isInCodeDir ? 'code' : isVault ? 'vault' : isWorkspace ? 'workspace' : 'other'}`);

    if (!isInCodeDir && !isWorkspace && !isVault) {
      log.info(HOOK, `skip: outside vault/code/workspace`);
      process.exit(0);
    }

    // Outer-scope declarations for cross-block references (statusline write below)
    let projectName = null;
    let session = null;

    const output = [];

    // ─── Global stale-session reconciliation (cp-re1) ────────────────
    // Runs on every SessionStart, every mode — closes abandoned `active`
    // session notes vault-wide, not just the current project's.
    try {
      const swept = sweepStaleActiveSessions(12);
      if (swept.closed > 0) {
        output.push(`Reconciled ${swept.closed} abandoned session(s) (no activity >12h): ${swept.names.join(', ')}`);
        output.push('');
      }
    } catch (e) { log.warn(HOOK, `stale sweep failed: ${e.message}`); }

    // ─── Workspace or Vault mode ───────────────────────────────────
    if (isWorkspace || (isVault && !isInCodeDir)) {
      const label = isWorkspace ? 'Workspace' : 'Vault';
      output.push(`=== VAULT AUTO-CONTEXT (${label}) ===`);

      const activeSessions = run(`node "${VAULT_QUERY}" session list --status active`);
      if (activeSessions) {
        output.push('');
        output.push('Active sessions:');
        output.push(activeSessions);
      }

      // In vault mode, scan for projects that have active sessions
      // so the user can resume or start tracking
      if (isVault) {
        // List all project notes to show what's trackable
        const projectsDir = path.join(VAULT_DIR, '1. Projects');
        if (fs.existsSync(projectsDir)) {
          const projectFiles = fs.readdirSync(projectsDir).filter(f => f.endsWith('.md'));
          const activeProjects = [];
          for (const file of projectFiles) {
            try {
              const content = fs.readFileSync(path.join(projectsDir, file), 'utf8');
              const statusMatch = content.match(/^status:\s*(\S+)/m);
              const nameMatch = content.match(/^name:\s*"?([^"\n]+)"?$/m);
              if (statusMatch && statusMatch[1] === 'active' && nameMatch) {
                activeProjects.push(nameMatch[1].trim());
              }
            } catch { continue; }
          }
          if (activeProjects.length > 0) {
            output.push('');
            output.push('Active projects with tracking: ' + activeProjects.join(', '));
          }
        }
        output.push('');
        output.push('VAULT MODE: Session tracking requires specifying which project you are working on.');
        output.push('When working on a code project from the vault, load context with: vault-query.mjs context <ProjectName>');
        output.push('A session note will be created when you start work on a recognized project.');
      } else {
        output.push('');
        output.push('Waiting for user to specify which project to work on.');
        output.push('Once specified, load project context with: vault-query.mjs context <ProjectName>');
      }
      output.push(`=== END AUTO-CONTEXT ===`);

    // ─── Project mode ────────────────────────────────────────────────
    } else {
      projectName = findProjectName(folderName);

      if (!projectName) {
        // Don't invent a stub project for a generic/parent/working dir (~/code,
        // scripts, web, a sandbox, ...). Only AUTO-creation is gated — if the
        // user has a real project note for this folder, findProjectName above
        // already resolved it, so legitimately-named projects still track.
        if (isIgnoredFolder(folderName)) {
          log.info(HOOK, `skip auto-create: "${folderName}" is an ignored generic dir (no project note) — add a real 1. Projects note to track it`);
          if (output.length) process.stdout.write(output.join('\n'));
          process.exit(0);
        }
        log.warn(HOOK, `no project file in vault for folder "${folderName}" — auto-creating`);
        projectName = autoCreateProjectFile(folderName);
      }
      if (!projectName) {
        log.error(HOOK, `failed to resolve or create project for folder "${folderName}" — session won't track`);
        process.exit(0);
      }

      const branch = getGitBranch(cwd);
      log.info(HOOK, `project mode: ${projectName} (folder=${folderName}, branch=${branch})`);

      output.push(`=== VAULT AUTO-CONTEXT (${projectName}) ===`);

      // Load project context (metadata, architecture notes, etc.)
      const context = run(`node "${VAULT_QUERY}" context "${projectName}"`);
      if (context) {
        output.push(context);
      }

      // ─── PRD context ────────────────────────────────────────────────
      try {
        const prdInfo = findPrdForFolder(folderName);
        if (prdInfo) {
          output.push('');
          output.push(`── PRD: ${prdInfo.relPath} ──`);
          output.push(`  status: ${prdInfo.fm.status || '?'} | build_status: ${prdInfo.fm.build_status || '?'} | seeded: ${prdInfo.fm.seeded === true ? 'yes' : 'no'}`);
          if (prdInfo.fm.seeded !== true && prdInfo.acceptanceCount > 0) {
            output.push(`  ${prdInfo.acceptanceCount} acceptance criteria not yet seeded — run:`);
            output.push(`    node "${PLUGIN_ROOT}/scripts/prd-seed.mjs" "${path.basename(prdInfo.relPath, '.md')}"`);
          } else if (prdInfo.fm.seeded === true) {
            output.push(`  ${prdInfo.fm.seeded_count || '?'} issue(s) seeded at ${prdInfo.fm.seeded_at || '?'}`);
          }
        }
      } catch (e) { log.warn(HOOK, `prd lookup failed: ${e.message}`); }

      // ─── Session: find or create ────────────────────────────────────
      session = findActiveSession(projectName);

      // Stale-session GC: if the active session is older than 12h, close
      // it and fall through to create a fresh one. Handles crashes /
      // missed SessionEnd hooks that leave `status: active` stuck on.
      if (session) {
        const startedMatch = session.content.match(/^started:\s*(.+)$/m);
        if (startedMatch) {
          const startedMs = Date.parse(startedMatch[1].trim());
          const ageHours = (Date.now() - startedMs) / 3600000;
          const STALE_HOURS = 12;
          if (Number.isFinite(ageHours) && ageHours > STALE_HOURS) {
            log.info(HOOK, `stale session (${ageHours.toFixed(1)}h old) — closing and creating fresh`);
            try {
              const nowIso = new Date().toISOString();
              let closed = session.content.replace(/\r\n/g, '\n');
              closed = closed.replace(/^status:\s*active\s*$/m, 'status: done');
              closed = closed.replace(/^ended:\s*null\s*$/m, `ended: ${nowIso}`);
              if (!/^ended:/m.test(closed)) {
                closed = closed.replace(/^(started:\s*[^\n]+)/m, `$1\nended: ${nowIso}`);
              }
              fs.writeFileSync(session.filepath, closed, 'utf-8');
            } catch (e) { log.warn(HOOK, `stale-close failed: ${e.message}`); }
            session = null;
          }
        }
      }

      if (session) {
        // Existing active session — inject its content
        output.push('');
        output.push(formatSessionContext(session.content, session.filename));
        output.push('');
        output.push(`RESUMING session: ${session.filename}`);
        output.push('REQUIRED ACTIONS (non-negotiable):');
        output.push('1. Confirm the Goal is still accurate — update ## Goal if scope has changed.');
        output.push('2. Log every key decision in ## Decisions as you make it.');
        output.push('3. Update ## Progress after each significant completed unit of work.');
        output.push('4. Log blockers in ## Blockers immediately when they occur.');
        output.push('The session file is at: 2. Areas/Sessions/' + session.relPath);

        // Check for in_progress beads issues — nudge Claude if none are active
        try {
          const beadsDir = path.join(cwd, '.beads');
          if (fs.existsSync(beadsDir)) {
            const { execSync } = require('child_process');
            const raw = execSync('bd list --json --all', { cwd, encoding: 'utf8', timeout: 10000, stdio: ['pipe','pipe','ignore'], windowsHide: true });
            const issues = JSON.parse(raw);
            const inProgress = issues.filter(i => i.status === 'in_progress');
            const open = issues.filter(i => i.status === 'open');
            if (inProgress.length === 0) {
              output.push('');
              output.push('⚠ BEADS: No issues are marked in_progress.');
              if (open.length > 0) {
                output.push(`  ${open.length} open issue(s) available. Mark the one you are working on:`);
                for (const i of open.slice(0, 5)) {
                  output.push(`    bd update ${i.id} --status in_progress  # ${i.title.substring(0, 60)}`);
                }
                if (open.length > 5) output.push(`    ... and ${open.length - 5} more`);
              }
              output.push('  ACTION: Run the bd update command for the issue you are starting on.');
            } else {
              output.push('');
              output.push(`✓ BEADS: ${inProgress.length} issue(s) in progress: ${inProgress.map(i => i.id).join(', ')}`);
            }
          }
        } catch { /* non-fatal */ }
      } else {
        // No active session — auto-create one. Pass sessionId so the stub is
        // identifiable and the distiller can upgrade it in place (not duplicate).
        const created = createSession(projectName, branch, sessionId);

        // Write loaded project context into ## Context section of the new note
        if (context) {
          try {
            const contextLines = context.split('\n').slice(0, 20).join('\n');
            let sessionContent = fs.readFileSync(created.filepath, 'utf8');
            sessionContent = sessionContent.replace(
              /## Context[\s\S]*?(?=\n## )/,
              '## Context\n' + contextLines + '\n'
            );
            fs.writeFileSync(created.filepath, sessionContent, 'utf8');
          } catch (e) { /* non-fatal */ }
        }

        output.push('');
        output.push(`AUTO-CREATED session: ${created.filename}`);
        output.push('Session file: 2. Areas/Sessions/' + created.relPath);
        output.push('');
        output.push('SESSION INSTRUCTIONS (NON-NEGOTIABLE):');
        output.push('1. IMMEDIATELY ask the user their goal and write it to ## Goal in the session note.');
        output.push('2. Every key decision: append to ## Decisions before moving on.');
        output.push('3. After each meaningful unit of work: append to ## Progress with specifics.');
        output.push('4. Blockers: append to ## Blockers the moment they occur.');
        output.push('5. Before session ends: vault-query.mjs session close --summary "..."');
      }

      // Load recent transcript from last Claude Code session (project/code
      // mode only — this block is the `else` of the vault/workspace branch, so
      // vault & workspace sessions never reach here and keep getting vault
      // context, not transcript context). Encoded from the real cwd.
      // cp-wqi / HD-R1.1: prefer the documented data.transcript_path from
      // stdin; fall back to the cwd-encoded transcript dir scan.
      const transcript = getRecentTranscriptContext(cwd, data.transcript_path);
      if (transcript) {
        output.push('');
        output.push(`── LAST SESSION TRANSCRIPT (${transcript.slug || transcript.sessionId}) ──`);
        if (transcript.lastTimestamp) {
          output.push(`Last active: ${transcript.lastTimestamp}`);
        }
        output.push(`Resume command: claude --resume ${transcript.sessionId}`);
        output.push('');
        output.push('Last user messages:');
        for (const msg of transcript.recentMessages) {
          output.push(`  > ${msg}`);
        }
        output.push('── END TRANSCRIPT ──');
      }

      output.push('=== END AUTO-CONTEXT ===');
    }

    process.stdout.write(output.join('\n'));

    // Write initial statusline state so goal shows before any tool calls
    if (projectName && session) {
      try {
        const goalMatch = session.content.match(/## Goal\s*\n([\s\S]*?)(?=\n## )/);
        let goal = '';
        if (goalMatch) {
          const text = goalMatch[1].trim();
          if (text && !text.match(/^\(none|^\(waiting|^\(session just/i)) {
            goal = text.split('\n').find(l => l.trim())?.replace(/^[-*#]\s*/, '').trim().substring(0, 120) || '';
          }
        }
        const STATE_FILE = path.join(os.homedir(), '.claude', 'statusline-live.json');
        fs.writeFileSync(STATE_FILE, JSON.stringify({
          goal,
          project: projectName,
          cwd,
          sessionFile: session.filename,
          activeTimer: null,   // timer filled in later by statusline-state.js async hook
          updatedAt: new Date().toISOString(),
        }));
      } catch { /* non-fatal */ }
    }

    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message} at ${e.stack?.split('\n')[1]?.trim() || ''}`);
    process.exit(0);
  }
});
