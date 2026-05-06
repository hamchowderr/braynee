// statusline-state.js
// Hook: PostToolUse (async) — writes live context for statusline display
// Matcher: "Write|Edit|Bash"
// async: true — never blocks Claude, runs in background after tool use
//
// Writes ~/.claude/statusline-live.json with:
//   - goal: first line of active session's ## Goal
//   - activeTimer: current TaskNotes timer title + elapsed
//   - project: current project name
//
// Statusline reads this file instantly on every render.

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

const VAULT_DIR = path.join(process.env.USERPROFILE, 'Obsidian Vault');
const SESSIONS_DIR = path.join(VAULT_DIR, '2. Areas', 'Sessions');
const CODE_DIR = path.join(process.env.USERPROFILE, 'code');
const STATE_FILE = path.join(process.env.USERPROFILE, '.claude', 'statusline-live.json');
const AUTH_TOKEN = process.env.TASKNOTES_TOKEN || '5Z3IySQ9uI5jzH0q8sMp+Np0vruJILVSLhX1PITANl0=';

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
    } catch { continue; }
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
  } catch {}
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

// Hit TaskNotes API with tight timeout — fail fast if not available
function getActiveTimer() {
  return new Promise((resolve) => {
    const deadline = setTimeout(() => resolve(null), 400);
    const sock = net.createConnection({ host: 'localhost', port: 8081 }, () => {
      sock.destroy();
      const req = http.request({
        hostname: 'localhost', port: 8081, path: '/api/time/active',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` },
        timeout: 300,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          clearTimeout(deadline);
          try {
            const parsed = JSON.parse(data);
            const sessions = parsed.data?.activeSessions || [];
            if (sessions.length > 0) {
              const s = sessions[0];
              resolve({ title: s.task?.title || 'Timer running', elapsedMinutes: s.elapsedMinutes || 0 });
            } else {
              resolve(null);
            }
          } catch { resolve(null); }
        });
      });
      req.on('error', () => { clearTimeout(deadline); resolve(null); });
      req.on('timeout', () => { req.destroy(); clearTimeout(deadline); resolve(null); });
      req.end();
    });
    sock.on('error', () => { clearTimeout(deadline); resolve(null); });
    sock.setTimeout(200, () => { sock.destroy(); clearTimeout(deadline); resolve(null); });
  });
}

// Query beads for open issue count and in-progress item — fast-fail if server not ready
function getBeadsData(projectDir) {
  return new Promise((resolve) => {
    if (!fs.existsSync(path.join(projectDir, '.beads'))) return resolve(null);
    const { spawn } = require('child_process');

    function runBd(args) {
      return new Promise((res) => {
        const dl = setTimeout(() => { p.kill(); res(''); }, 1000);
        const p = spawn('bd', args, { cwd: projectDir, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        let o = '';
        p.stdout.on('data', c => { o += c; });
        p.on('close', () => { clearTimeout(dl); res(o); });
        p.on('error', () => { clearTimeout(dl); res(''); });
      });
    }

    const deadline = setTimeout(() => resolve(null), 2000);
    Promise.all([
      runBd(['list', '--flat', '--status=open']),
      runBd(['count', '--status=open']),
      runBd(['ready']),
    ]).then(([openOut, countOut, readyOut]) => {
      clearTimeout(deadline);
      const openLines = openOut.split('\n').filter(l => l.trim() && !l.startsWith('─') && !l.startsWith('No issues'));
      const openCount = openLines.length || 0;
      const readyLines = readyOut.split('\n').filter(l => /^[○◐●]/.test(l.trim()));
      const readyCount = readyLines.length || 0;
      if (!openCount && !readyCount) return resolve(null);
      resolve({ openCount, readyCount });
    }).catch(() => { clearTimeout(deadline); resolve(null); });
  });
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);
    const cwd = data.cwd || process.cwd();
    const folderName = path.basename(cwd);
    if (!cwd.toLowerCase().startsWith(CODE_DIR.toLowerCase()) || folderName.toLowerCase() === 'workspace') {
      process.exit(0);
    }

    const projectName = findProjectName(folderName);
    if (!projectName) process.exit(0);

    const session = findActiveSession(projectName);
    const goal = session ? extractGoal(session.content) : '';
    const [timer, beads] = await Promise.all([getActiveTimer(), getBeadsData(cwd)]);

    const state = {
      goal,
      project: projectName,
      cwd,
      sessionFile: session?.filename || '',
      activeTimer: timer,
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
