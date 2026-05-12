// session-end.js
// Hook: SessionEnd — Marks the active session note done, writes ended timestamp.
// Also runs `bd prime` so the next session inherits beads context.
//
// The bulk of the session-note write (Goal, Progress from commits, Session
// Summary) is already done by session-auto-close.js on every Stop. This hook
// just performs the final status flip and timestamp write so SessionStart on
// the next launch doesn't try to resume a stale session.

const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'session-end';
const VAULT_DIR = path.join(os.homedir(), 'Obsidian Vault');
const SESSIONS_DIR = path.join(VAULT_DIR, '2. Areas', 'Sessions');
const CODE_DIR = path.join(os.homedir(), 'code');

function findProjectName(folderName) {
  const projectsDir = path.join(VAULT_DIR, '1. Projects');
  if (!fs.existsSync(projectsDir)) return null;
  for (const file of fs.readdirSync(projectsDir).filter(f => f.endsWith('.md'))) {
    try {
      const content = fs.readFileSync(path.join(projectsDir, file), 'utf8');
      const folderMatch = content.match(/^folder:\s*"?([^"\n]+)"?$/m);
      if (folderMatch && folderMatch[1].trim().toLowerCase() === folderName.toLowerCase()) {
        const nameMatch = content.match(/^name:\s*"?([^"\n]+)"?$/m);
        if (nameMatch) return nameMatch[1].trim();
        return file.replace('.md', '');
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
        if (projectMatch && projectMatch[1].trim().toLowerCase() === projectName.toLowerCase()) {
          return { filepath, content };
        }
      } catch { continue; }
    }
  }
  return null;
}

function closeSessionFile(filepath, content) {
  const now = new Date().toISOString();
  let updated = content.replace(/\r\n/g, '\n');
  updated = updated.replace(/^status:\s*active\s*$/m, 'status: done');
  updated = updated.replace(/^ended:\s*null\s*$/m, `ended: ${now}`);
  if (!/^ended:/m.test(updated)) {
    updated = updated.replace(/^(started:\s*[^\n]+)/m, `$1\nended: ${now}`);
  }
  fs.writeFileSync(filepath, updated, 'utf-8');
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = input ? JSON.parse(input) : {};
    const cwd = data.cwd || process.cwd();
    const folderName = path.basename(cwd);
    const isInCodeDir = cwd.toLowerCase().startsWith(CODE_DIR.toLowerCase());

    // bd prime so the next session inherits context (unchanged behavior)
    if (isInCodeDir) {
      try { execSync('bd prime', { cwd, encoding: 'utf8', timeout: 5000, stdio: 'ignore', windowsHide: true }); } catch {}
    }

    if (!isInCodeDir || folderName.toLowerCase() === 'workspace') {
      process.exit(0);
    }

    const projectName = findProjectName(folderName);
    if (!projectName) {
      log.info(HOOK, `no project file for folder "${folderName}" — skip close`);
      process.exit(0);
    }

    const session = findActiveSession(projectName);
    if (!session) {
      log.info(HOOK, `no active session for ${projectName} — nothing to close`);
      process.exit(0);
    }

    closeSessionFile(session.filepath, session.content);
    log.info(HOOK, `closed session ${path.basename(session.filepath)} for ${projectName}`);
    process.stderr.write(`Session note closed: ${path.basename(session.filepath)}\n`);
  } catch (e) {
    try { log.error(HOOK, `crash: ${e.message}`); } catch {}
  }
  process.exit(0);
});
