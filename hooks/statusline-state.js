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
    const beads = await getBeadsData(codeRoot);

    const state = {
      goal,
      project: projectName,
      cwd,
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
