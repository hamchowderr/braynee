#!/usr/bin/env node
// beads-dashboard.js — Generates a self-contained HTML dashboard of beads projects.
//
// Usage:
//   node beads-dashboard.js                    # scan current project only
//   node beads-dashboard.js --scan-all         # scan all projects (slow)
//   node beads-dashboard.js --open             # open in browser after generating
//   node beads-dashboard.js --output path.html # custom output path

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.USERPROFILE || os.homedir();
const CODE_DIR = process.env.BEADS_CODE_DIR || path.join(HOME, 'code');
const DEFAULT_OUTPUT = process.env.BEADS_OUTPUT || path.join(HOME, '.claude', 'beads-dashboard.html');
const CACHE_PATH = path.join(HOME, '.claude', 'beads-dashboard-cache.json');

const args = process.argv.slice(2);
let outputPath = DEFAULT_OUTPUT;
let shouldOpen = false;
let scanAll = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output' && args[i + 1]) outputPath = args[++i];
  if (args[i] === '--open') shouldOpen = true;
  if (args[i] === '--scan-all') scanAll = true;
}

const cwd = process.cwd();
const cwdName = cwd.startsWith(CODE_DIR) ? path.relative(CODE_DIR, cwd).split(path.sep)[0] : null;

function findBeadsProjects() {
  const projects = [];
  try {
    const entries = fs.readdirSync(CODE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(CODE_DIR, entry.name, '.beads'))) {
        projects.push({ name: entry.name, path: path.join(CODE_DIR, entry.name) });
      }
    }
  } catch {}
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

function getProjectIssues(projectPath) {
  try {
    return JSON.parse(execSync('bd list --json --all', {
      cwd: projectPath, timeout: 10000, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
  } catch { return null; }
}

function loadCache() {
  try { return fs.existsSync(CACHE_PATH) ? JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) : {}; }
  catch { return {}; }
}

function saveCache(data) {
  const c = {};
  for (const p of data) {
    if (p.scanned) c[p.name] = { issues: p.issues, stats: p.stats, scannedAt: p.scannedAt };
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(c));
}

const projects = findBeadsProjects();
const cache = loadCache();
const activeProject = cwdName || '';

console.log(`Found ${projects.length} beads projects`);
if (!scanAll) console.log(`Scanning active project: ${activeProject || '(none)'}`);

const allData = [];
let totalOpen = 0, totalInProgress = 0, totalClosed = 0, totalBlocked = 0, scannedCount = 0;

for (const project of projects) {
  const shouldScan = scanAll || project.name === activeProject;
  if (shouldScan) {
    process.stdout.write(`  ${project.name}...`);
    const issues = getProjectIssues(project.path);
    if (issues !== null) {
      const open = issues.filter(i => i.status === 'open').length;
      const inProgress = issues.filter(i => i.status === 'in_progress').length;
      const closed = issues.filter(i => i.status === 'closed').length;
      const blocked = issues.filter(i => i.status === 'blocked').length;
      totalOpen += open; totalInProgress += inProgress;
      totalClosed += closed; totalBlocked += blocked; scannedCount++;
      allData.push({
        name: project.name, path: project.path, issues,
        stats: { open, inProgress, closed, blocked, total: issues.length },
        scanned: true, scannedAt: new Date().toISOString(),
        active: project.name === activeProject,
      });
      console.log(` ${issues.length} issues`);
    } else {
      const cached = cache[project.name];
      allData.push({
        name: project.name, path: project.path,
        issues: cached?.issues || [],
        stats: cached?.stats || { open: 0, inProgress: 0, closed: 0, blocked: 0, total: 0 },
        scanned: false, scannedAt: cached?.scannedAt || null,
        active: project.name === activeProject,
      });
      console.log(` (scan failed, using cache)`);
    }
  } else {
    const cached = cache[project.name];
    if (cached) {
      totalOpen += cached.stats.open || 0; totalInProgress += cached.stats.inProgress || 0;
      totalClosed += cached.stats.closed || 0; totalBlocked += cached.stats.blocked || 0;
    }
    allData.push({
      name: project.name, path: project.path,
      issues: cached?.issues || [],
      stats: cached?.stats || { open: 0, inProgress: 0, closed: 0, blocked: 0, total: 0 },
      scanned: false, scannedAt: cached?.scannedAt || null, active: false,
    });
  }
}

saveCache(allData);

const timestamp = new Date().toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
});
const RELOAD_SECS = 20;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Beads — ${activeProject || 'Dashboard'}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=JetBrains+Mono:ital,wght@0,400;0,500;0,700;1,400&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:       #0b0b0d;
    --s1:       #111114;
    --s2:       #17171b;
    --s3:       #1d1d22;
    --border:   #222226;
    --border2:  #2e2e34;
    --text:     #e2dfd8;
    --muted:    #5a5a62;
    --dim:      #333338;
    --acc:      #d4ff47;
    --acc-dim:  rgba(212,255,71,.1);
    --green:    #4dffa0;
    --green-d:  rgba(77,255,160,.1);
    --yellow:   #ffc844;
    --yellow-d: rgba(255,200,68,.1);
    --red:      #ff5252;
    --red-d:    rgba(255,82,82,.1);
    --blue:     #52a8ff;
    --blue-d:   rgba(82,168,255,.1);
    --orange:   #ff8c42;
    --mono: 'JetBrains Mono', monospace;
    --display: 'Bebas Neue', sans-serif;
  }

  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    font-family: var(--mono);
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    overflow-x: hidden;
  }
  body::before {
    content: '';
    position: fixed; inset: 0; z-index: 0; pointer-events: none;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E");
    background-size: 200px 200px;
    opacity: 0.018;
  }

  .wrap { position: relative; z-index: 1; max-width: 1280px; margin: 0 auto; padding: 0 28px; }

  /* ── Top bar ── */
  .topbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 18px 0 16px;
    border-bottom: 1px solid var(--border);
  }
  .topbar-left { display: flex; align-items: baseline; gap: 16px; }
  .logotype { font-family: var(--display); font-size: 22px; letter-spacing: 3px; color: var(--acc); }
  .topbar-meta { font-size: 10px; color: var(--muted); letter-spacing: 0.5px; text-transform: uppercase; }

  .topbar-right { display: flex; align-items: center; gap: 24px; }
  .topbar-stats { display: flex; gap: 20px; }
  .topbar-stat { text-align: right; }
  .topbar-stat .n { font-family: var(--display); font-size: 20px; letter-spacing: 1px; line-height: 1; }
  .topbar-stat .l { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
  .topbar-stat.s-open .n  { color: var(--blue); }
  .topbar-stat.s-prog .n  { color: var(--yellow); }
  .topbar-stat.s-block .n { color: var(--red); }
  .topbar-stat.s-done .n  { color: var(--green); }

  /* Reload countdown */
  .reload-ring {
    display: flex; flex-direction: column; align-items: center; gap: 2px; cursor: pointer;
    opacity: 0.5; transition: opacity 0.2s;
  }
  .reload-ring:hover { opacity: 1; }
  .reload-svg { display: block; }
  .reload-n { font-size: 9px; color: var(--muted); letter-spacing: 0.5px; text-transform: uppercase; }

  /* ── Hero ── */
  .hero { padding: 32px 0 0; border-bottom: 1px solid var(--border); margin-bottom: 28px; }
  .hero-no-project {
    padding: 40px 0; text-align: center;
    font-size: 12px; color: var(--muted); letter-spacing: 1px; text-transform: uppercase;
  }
  .hero-eyebrow { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .pill-active {
    font-size: 9px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase;
    color: var(--bg); background: var(--acc); padding: 3px 10px; border-radius: 2px;
  }
  .hero-cached-note { font-size: 10px; color: var(--muted); font-style: italic; }
  .hero-name {
    font-family: var(--display);
    font-size: clamp(64px, 8vw, 108px);
    letter-spacing: 4px; line-height: 0.92;
    color: var(--text); margin-bottom: 20px; word-break: break-all;
  }
  .hero-name .acc { color: var(--acc); }

  /* ── Issue tabs ── */
  .tabs-row { display: flex; gap: 0; border-bottom: 1px solid var(--border); }
  .tab-btn {
    font-family: var(--mono); font-size: 11px; font-weight: 500;
    letter-spacing: 1px; text-transform: uppercase;
    padding: 10px 18px; cursor: pointer;
    color: var(--muted); border-bottom: 2px solid transparent;
    margin-bottom: -1px; background: none;
    border-top: none; border-left: none; border-right: none;
    transition: color 0.15s, border-color 0.15s;
  }
  .tab-btn:hover { color: var(--text); }
  .tab-btn.active { color: var(--acc); border-bottom-color: var(--acc); }
  .tab-btn .tc {
    display: inline-block; min-width: 18px; text-align: center;
    font-size: 10px; color: var(--dim); margin-left: 4px; transition: color 0.15s;
  }
  .tab-btn.active .tc { color: var(--muted); }

  .tab-panel { display: none; }
  .tab-panel.vis { display: block; }

  /* ── Issue table ── */
  .issue-table { width: 100%; border-collapse: collapse; }
  .issue-table tbody tr.issue-main-row {
    border-bottom: 1px solid var(--border);
    cursor: pointer; transition: background 0.1s;
  }
  .issue-table tbody tr.issue-main-row:hover { background: var(--s1); }
  .issue-table tbody tr.issue-detail-row { display: none; border-bottom: 1px solid var(--border); }
  .issue-table tbody tr.issue-detail-row.open { display: table-row; }
  .issue-table td { padding: 10px 6px; font-size: 12px; vertical-align: middle; }

  .td-dot  { width: 22px; }
  .td-id   { width: 130px; color: var(--dim); font-size: 11px; white-space: nowrap; }
  .td-title { color: var(--text); }
  .td-pri  { width: 40px; text-align: right; }
  .td-caret { width: 20px; text-align: right; color: var(--dim); font-size: 10px; transition: transform 0.15s; }
  tr.expanded .td-caret { transform: rotate(90deg); color: var(--muted); }

  /* Issue detail panel */
  .issue-detail-cell { padding: 0 6px 14px 28px !important; }
  .detail-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px;
    background: var(--s2); border: 1px solid var(--border);
    border-radius: 4px; padding: 14px 16px; margin-top: 2px;
  }
  .detail-full { grid-column: 1 / -1; }
  .detail-label {
    font-size: 9px; text-transform: uppercase; letter-spacing: 1.5px;
    color: var(--muted); margin-bottom: 4px;
  }
  .detail-value { font-size: 11px; color: var(--text); line-height: 1.6; }
  .detail-value.mono { font-family: var(--mono); }
  .detail-value.dim { color: var(--muted); font-style: italic; }
  .detail-deps { display: flex; flex-wrap: wrap; gap: 6px; }
  .dep-chip {
    font-size: 10px; padding: 2px 8px; border-radius: 2px;
    border: 1px solid var(--border2); color: var(--muted);
    font-family: var(--mono);
  }
  .dep-chip.blocks { border-color: rgba(255,82,82,.3); color: var(--red); }
  .dep-chip.blocked-by { border-color: rgba(255,200,68,.3); color: var(--yellow); }

  .sdot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  }
  .sdot.open       { background: var(--blue);   box-shadow: 0 0 6px var(--blue); }
  .sdot.in_progress { background: var(--yellow); box-shadow: 0 0 6px var(--yellow); }
  .sdot.blocked    { background: var(--red);     box-shadow: 0 0 6px var(--red); }
  .sdot.closed     { background: var(--dim); }

  .pri {
    font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 2px;
    font-family: var(--mono); letter-spacing: 0.5px;
  }
  .pri.p0 { background: var(--red-d);    color: var(--red); }
  .pri.p1 { background: var(--yellow-d); color: var(--orange); }
  .pri.p2 { background: var(--yellow-d); color: var(--yellow); opacity: 0.7; }
  .pri.p3 { background: var(--s2);       color: var(--muted); }
  .pri.p4 { background: var(--s2);       color: var(--dim); }

  .empty-panel { padding: 24px 6px; font-size: 11px; color: var(--dim); letter-spacing: 1px; text-transform: uppercase; }

  /* ── Projects section ── */
  .section-bar {
    display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;
  }
  .section-label {
    font-family: var(--display); font-size: 13px; letter-spacing: 3px;
    color: var(--muted); text-transform: uppercase;
  }
  .filter-row { display: flex; gap: 8px; }
  .filter-row input,
  .filter-row select {
    font-family: var(--mono); font-size: 11px;
    background: var(--s1); border: 1px solid var(--border);
    color: var(--text); padding: 6px 10px; border-radius: 3px;
    outline: none; transition: border-color 0.15s;
  }
  .filter-row input { width: 180px; }
  .filter-row input::placeholder { color: var(--dim); }
  .filter-row input:focus,
  .filter-row select:focus { border-color: var(--border2); }

  /* Pagination */
  .pagination {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 0 32px;
  }
  .pag-info { font-size: 11px; color: var(--muted); letter-spacing: 0.5px; }
  .pag-info strong { color: var(--text); }
  .pag-btns { display: flex; gap: 6px; }
  .pag-btn {
    font-family: var(--mono); font-size: 11px; font-weight: 500;
    background: var(--s1); border: 1px solid var(--border); color: var(--muted);
    padding: 5px 14px; border-radius: 3px; cursor: pointer; letter-spacing: 0.5px;
    transition: border-color 0.15s, color 0.15s;
  }
  .pag-btn:hover:not(:disabled) { border-color: var(--border2); color: var(--text); }
  .pag-btn:disabled { opacity: 0.3; cursor: default; }
  .pag-pages { display: flex; gap: 4px; align-items: center; }
  .pag-page {
    font-family: var(--mono); font-size: 11px; min-width: 28px; text-align: center;
    background: var(--s1); border: 1px solid var(--border); color: var(--muted);
    padding: 4px 6px; border-radius: 3px; cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .pag-page:hover { border-color: var(--border2); color: var(--text); }
  .pag-page.active { border-color: var(--acc); color: var(--acc); background: var(--acc-dim); }
  .pag-ellipsis { font-size: 11px; color: var(--dim); padding: 0 2px; }

  /* Project grid */
  .proj-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 1px; background: var(--border);
    border: 1px solid var(--border); border-radius: 4px;
    overflow: hidden; margin-bottom: 12px;
  }
  .proj-cell {
    background: var(--bg); padding: 10px 14px;
    display: flex; align-items: center; justify-content: space-between;
    cursor: pointer; gap: 8px; transition: background 0.1s; min-height: 42px;
  }
  .proj-cell:hover { background: var(--s1); }
  .proj-cell.expanded {
    grid-column: 1 / -1; flex-direction: column; align-items: stretch;
    background: var(--s1); padding: 14px;
  }
  .proj-cell-top {
    display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;
  }
  .proj-name { font-size: 11px; font-weight: 500; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
  .proj-name.dim { color: var(--muted); }
  .proj-dots { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }

  .mini-badge {
    font-size: 10px; padding: 1px 6px; border-radius: 2px;
    font-family: var(--mono); font-weight: 700; white-space: nowrap;
  }
  .mb-open  { background: var(--blue-d);   color: var(--blue); }
  .mb-prog  { background: var(--yellow-d); color: var(--yellow); }
  .mb-block { background: var(--red-d);    color: var(--red); }
  .mb-done  { background: var(--green-d);  color: var(--green); opacity: 0.6; }
  .mb-none  { color: var(--dim); font-size: 10px; }

  .proj-expanded-issues { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 10px; }
  .no-proj { color: var(--dim); font-size: 11px; padding: 16px; text-align: center; }
</style>
</head>
<body>
<div class="wrap">

  <div class="topbar">
    <div class="topbar-left">
      <span class="logotype">BEADS</span>
      <span class="topbar-meta">${timestamp} &nbsp;&bull;&nbsp; ${projects.length} projects</span>
    </div>
    <div class="topbar-right">
      <div class="topbar-stats">
        <div class="topbar-stat s-open">
          <div class="n">${totalOpen}</div><div class="l">Open</div>
        </div>
        <div class="topbar-stat s-prog">
          <div class="n">${totalInProgress}</div><div class="l">Active</div>
        </div>
        <div class="topbar-stat s-block">
          <div class="n">${totalBlocked}</div><div class="l">Blocked</div>
        </div>
        <div class="topbar-stat s-done">
          <div class="n">${totalClosed}</div><div class="l">Done</div>
        </div>
      </div>
      <!-- Reload ring -->
      <div class="reload-ring" title="Auto-refreshes every ${RELOAD_SECS}s — click to reload now" onclick="location.reload()">
        <svg class="reload-svg" width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="13" fill="none" stroke="#222226" stroke-width="2.5"/>
          <circle id="ring-progress" cx="16" cy="16" r="13" fill="none"
            stroke="#d4ff47" stroke-width="2.5" stroke-linecap="round"
            stroke-dasharray="81.7" stroke-dashoffset="81.7"
            transform="rotate(-90 16 16)" style="transition: stroke-dashoffset 1s linear"/>
          <text x="16" y="20" text-anchor="middle" fill="#5a5a62"
            font-family="'JetBrains Mono',monospace" font-size="9" id="ring-n">${RELOAD_SECS}</text>
        </svg>
        <span class="reload-n">reload</span>
      </div>
    </div>
  </div>

  <div class="hero" id="hero"></div>

  <div class="section-bar">
    <span class="section-label">All Projects</span>
    <div class="filter-row">
      <input type="text" id="search" placeholder="filter..." oninput="filterGrid()">
      <select id="sf" onchange="filterGrid()">
        <option value="all">All</option>
        <option value="active">In progress</option>
        <option value="blocked">Blocked</option>
        <option value="has-issues">Has issues</option>
        <option value="empty">No issues</option>
      </select>
    </div>
  </div>
  <div class="proj-grid" id="proj-grid"></div>
  <div class="pagination" id="pagination"></div>

</div>

<script>
const DATA = ${JSON.stringify(allData)};
const RELOAD_SECS = ${RELOAD_SECS};
const active = DATA.find(p => p.active) || null;
const others = DATA.filter(p => !p.active);

// ── Auto-reload countdown ──
let remaining = RELOAD_SECS;
const ring = document.getElementById('ring-progress');
const ringN = document.getElementById('ring-n');
const circ = 2 * Math.PI * 13; // 81.68

function updateRing() {
  const frac = 1 - (remaining / RELOAD_SECS);
  ring.style.strokeDashoffset = (circ * (1 - frac)).toFixed(2);
  ringN.textContent = remaining;
}

updateRing();
const ticker = setInterval(() => {
  remaining--;
  updateRing();
  if (remaining <= 0) { clearInterval(ticker); location.reload(); }
}, 1000);

// ── Helpers ──
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function renderDot(status) { return \`<span class="sdot \${status}"></span>\`; }
function renderPri(p) { const v = p??2; return \`<span class="pri p\${v}">P\${v}</span>\`; }

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

// ── Issue detail panel ──
function issueDetail(issue) {
  const deps = issue.dependencies || [];
  const blockedBy = deps.filter(d => d.issue_id === issue.id && d.type === 'blocks');
  const blocks    = deps.filter(d => d.depends_on_id === issue.id);

  const depHtml = [];
  if (blockedBy.length) depHtml.push(
    '<div class="detail-label">Blocked by</div><div class="detail-deps">' +
    blockedBy.map(d => \`<span class="dep-chip blocked-by">\${esc(d.depends_on_id)}</span>\`).join('') +
    '</div>'
  );
  if (blocks.length) depHtml.push(
    '<div class="detail-label">Blocks</div><div class="detail-deps">' +
    blocks.map(d => \`<span class="dep-chip blocks">\${esc(d.issue_id)}</span>\`).join('') +
    '</div>'
  );

  return \`
    <div class="detail-grid">
      \${issue.description ? \`
        <div class="detail-full">
          <div class="detail-label">Description</div>
          <div class="detail-value">\${esc(issue.description)}</div>
        </div>
      \` : ''}
      \${issue.close_reason ? \`
        <div class="detail-full">
          <div class="detail-label">Close reason</div>
          <div class="detail-value dim">\${esc(issue.close_reason)}</div>
        </div>
      \` : ''}
      \${depHtml.length ? \`<div class="detail-full">\${depHtml.join('')}</div>\` : ''}
      <div>
        <div class="detail-label">Created</div>
        <div class="detail-value mono dim">\${fmtDate(issue.created_at)}</div>
      </div>
      <div>
        <div class="detail-label">Updated</div>
        <div class="detail-value mono dim">\${fmtDate(issue.updated_at)}</div>
      </div>
      \${issue.owner ? \`
        <div>
          <div class="detail-label">Owner</div>
          <div class="detail-value mono dim">\${esc(issue.created_by || issue.owner)}</div>
        </div>
      \` : ''}
      <div>
        <div class="detail-label">Type</div>
        <div class="detail-value mono dim">\${esc(issue.issue_type || '—')}</div>
      </div>
    </div>
  \`;
}

// ── Issue table ──
function issueTable(issues) {
  if (!issues.length) return '<div class="empty-panel">Nothing here</div>';
  return \`<table class="issue-table"><tbody>\${issues.map(issue => \`
    <tr class="issue-main-row" onclick="toggleIssue(this)">
      <td class="td-dot">\${renderDot(issue.status)}</td>
      <td class="td-id">\${esc(issue.id)}</td>
      <td class="td-title">\${esc(issue.title)}</td>
      <td class="td-pri">\${renderPri(issue.priority)}</td>
      <td class="td-caret">&#9654;</td>
    </tr>
    <tr class="issue-detail-row">
      <td colspan="5" class="issue-detail-cell">\${issueDetail(issue)}</td>
    </tr>
  \`).join('')}</tbody></table>\`;
}

function toggleIssue(row) {
  const detailRow = row.nextElementSibling;
  if (!detailRow || !detailRow.classList.contains('issue-detail-row')) return;
  const isOpen = detailRow.classList.contains('open');
  document.querySelectorAll('.issue-detail-row.open').forEach(r => r.classList.remove('open'));
  document.querySelectorAll('.issue-main-row.expanded').forEach(r => r.classList.remove('expanded'));
  if (!isOpen) {
    detailRow.classList.add('open');
    row.classList.add('expanded');
  }
}

// ── Hero ──
function renderHero() {
  const el = document.getElementById('hero');
  if (!active) {
    el.innerHTML = '<div class="hero-no-project">No active beads project detected — open from inside a project directory</div>';
    return;
  }
  const p = active;
  const byStatus = {
    all:         p.issues,
    open:        p.issues.filter(i => i.status === 'open'),
    in_progress: p.issues.filter(i => i.status === 'in_progress'),
    blocked:     p.issues.filter(i => i.status === 'blocked'),
    closed:      p.issues.filter(i => i.status === 'closed'),
  };

  const tabs = [
    { id: 'all',         label: 'All',        issues: byStatus.all },
    { id: 'in_progress', label: 'In Progress', issues: byStatus.in_progress },
    { id: 'open',        label: 'Open',        issues: byStatus.open },
    { id: 'blocked',     label: 'Blocked',     issues: byStatus.blocked },
    { id: 'closed',      label: 'Done',        issues: byStatus.closed },
  ].filter(t => t.id === 'all' || t.issues.length);

  const defTab = byStatus.in_progress.length ? 'in_progress'
    : byStatus.open.length ? 'open'
    : byStatus.blocked.length ? 'blocked'
    : 'all';

  const nameParts = p.name.split(/[-_]/);
  const heroName = nameParts.length > 1
    ? esc(nameParts.slice(0,-1).join('-')) + '-<span class="acc">' + esc(nameParts[nameParts.length-1]) + '</span>'
    : '<span class="acc">' + esc(p.name) + '</span>';

  el.innerHTML = \`
    <div class="hero-eyebrow">
      <span class="pill-active">Active</span>
      \${!p.scanned && p.scannedAt ? '<span class="hero-cached-note">cached data</span>' : ''}
    </div>
    <div class="hero-name">\${heroName}</div>
    <div class="tabs-row" id="htabs">
      \${tabs.map(t => \`
        <button class="tab-btn\${t.id === defTab ? ' active' : ''}" data-tab="\${t.id}" onclick="switchHeroTab('\${t.id}')">
          \${t.label}<span class="tc">\${t.issues.length}</span>
        </button>
      \`).join('')}
    </div>
    \${tabs.map(t => \`
      <div class="tab-panel\${t.id === defTab ? ' vis' : ''}" id="hp-\${t.id}">
        \${issueTable(t.issues)}
      </div>
    \`).join('')}
  \`;
}

function switchHeroTab(id) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('vis', p.id === 'hp-' + id));
}

// ── Project grid + pagination ──
const PAGE_SIZE = 10;
let currentPage = 1;
let currentData = [];

function miniBadges(p) {
  const b = [];
  if (p.stats.blocked > 0)    b.push(\`<span class="mini-badge mb-block">\${p.stats.blocked}B</span>\`);
  if (p.stats.inProgress > 0) b.push(\`<span class="mini-badge mb-prog">\${p.stats.inProgress}▶</span>\`);
  if (p.stats.open > 0)       b.push(\`<span class="mini-badge mb-open">\${p.stats.open}</span>\`);
  if (p.stats.closed > 0 && !p.stats.open && !p.stats.inProgress && !p.stats.blocked)
    b.push(\`<span class="mini-badge mb-done">\${p.stats.closed}✓</span>\`);
  return b.join('');
}

function renderGrid(data, page) {
  currentData = data;
  currentPage = page || 1;

  const grid = document.getElementById('proj-grid');
  const pagEl = document.getElementById('pagination');

  if (!data.length) {
    grid.innerHTML = '<div class="no-proj">No projects match</div>';
    pagEl.innerHTML = '';
    return;
  }

  const totalPages = Math.ceil(data.length / PAGE_SIZE);
  const start = (currentPage - 1) * PAGE_SIZE;
  const slice = data.slice(start, start + PAGE_SIZE);

  grid.innerHTML = slice.map(p => {
    const badges = miniBadges(p);
    const expandedTable = p.issues.length ? issueTable(p.issues) : '<div class="empty-panel">No issues</div>';
    return \`<div class="proj-cell" data-name="\${esc(p.name)}" onclick="toggleCell(this)">
      <div class="proj-cell-top">
        <span class="proj-name\${!p.scannedAt ? ' dim' : ''}">\${esc(p.name)}</span>
        <div class="proj-dots">\${badges || (!p.scannedAt ? '<span class="mb-none">—</span>' : '')}</div>
      </div>
      <div class="proj-expanded-issues">\${expandedTable}</div>
    </div>\`;
  }).join('');

  // Pagination controls
  if (totalPages <= 1) { pagEl.innerHTML = ''; return; }

  const from = start + 1;
  const to = Math.min(start + PAGE_SIZE, data.length);

  // Build page number buttons (show up to 7, with ellipsis)
  function pageBtn(n) {
    return \`<span class="pag-page\${n === currentPage ? ' active' : ''}" onclick="goPage(\${n})">\${n}</span>\`;
  }
  let pageNums = '';
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pageNums += pageBtn(i);
  } else {
    pageNums += pageBtn(1);
    if (currentPage > 3) pageNums += '<span class="pag-ellipsis">…</span>';
    const lo = Math.max(2, currentPage - 1);
    const hi = Math.min(totalPages - 1, currentPage + 1);
    for (let i = lo; i <= hi; i++) pageNums += pageBtn(i);
    if (currentPage < totalPages - 2) pageNums += '<span class="pag-ellipsis">…</span>';
    pageNums += pageBtn(totalPages);
  }

  pagEl.innerHTML = \`
    <span class="pag-info">Showing <strong>\${from}–\${to}</strong> of <strong>\${data.length}</strong> projects</span>
    <div class="pag-btns">
      <button class="pag-btn" onclick="goPage(\${currentPage - 1})" \${currentPage === 1 ? 'disabled' : ''}>← Prev</button>
      <div class="pag-pages">\${pageNums}</div>
      <button class="pag-btn" onclick="goPage(\${currentPage + 1})" \${currentPage === totalPages ? 'disabled' : ''}>Next →</button>
    </div>
  \`;
}

function goPage(n) {
  const total = Math.ceil(currentData.length / PAGE_SIZE);
  if (n < 1 || n > total) return;
  document.querySelectorAll('.proj-cell.expanded').forEach(c => c.classList.remove('expanded'));
  renderGrid(currentData, n);
  document.getElementById('proj-grid').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function toggleCell(el) {
  if (el.classList.contains('expanded')) { el.classList.remove('expanded'); return; }
  document.querySelectorAll('.proj-cell.expanded').forEach(c => c.classList.remove('expanded'));
  el.classList.add('expanded');
}

function filterGrid() {
  const q = document.getElementById('search').value.toLowerCase();
  const sf = document.getElementById('sf').value;
  let d = [...others];
  if (q) d = d.filter(p => p.name.toLowerCase().includes(q) || p.issues.some(i => i.title.toLowerCase().includes(q)));
  if (sf === 'active')          d = d.filter(p => p.stats.inProgress > 0);
  else if (sf === 'blocked')    d = d.filter(p => p.stats.blocked > 0);
  else if (sf === 'has-issues') d = d.filter(p => p.stats.total > 0);
  else if (sf === 'empty')      d = d.filter(p => !p.stats.total);
  renderGrid(d, 1);
}

const sortedOthers = [...others].sort((a, b) => {
  if (b.stats.blocked !== a.stats.blocked)       return b.stats.blocked - a.stats.blocked;
  if (b.stats.inProgress !== a.stats.inProgress) return b.stats.inProgress - a.stats.inProgress;
  if (b.stats.open !== a.stats.open)             return b.stats.open - a.stats.open;
  return a.name.localeCompare(b.name);
});
others.length = 0;
others.push(...sortedOthers);

renderHero();
renderGrid(others);
</script>
</body>
</html>`;

fs.writeFileSync(outputPath, html);
console.log(`\nDashboard written to: ${outputPath}`);

if (shouldOpen) {
  try { execSync(`start "" "${outputPath}"`, { stdio: 'ignore' }); } catch {}
}
