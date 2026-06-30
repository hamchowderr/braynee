import { esc } from '../html/utils.mjs';

export function renderBeadsPanel(beadsStats) {
  return `<div id="panel-beads" class="panel">
    <div class="section-head">
      <div class="section-title">Beads</div>
      <div class="section-tag">issue tracker · ${beadsStats.workspaces} workspace${beadsStats.workspaces !== 1 ? 's' : ''} · ${beadsStats.totalOpen} open</div>
    </div>
    <div class="stats" style="grid-template-columns:repeat(4,1fr)">
      <div class="stat-box"><div class="stat-num" style="color:var(--amber)">${beadsStats.workspaces}</div><div class="stat-lbl">Workspaces</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--blue)">${beadsStats.activeProjects}</div><div class="stat-lbl">Active Projects</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--green)">${beadsStats.totalOpen}</div><div class="stat-lbl">Open Issues</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--red)">${beadsStats.assignedToMe}</div><div class="stat-lbl">Mine${beadsStats.currentUser ? ` (@${esc(beadsStats.currentUser)})` : ''}</div></div>
    </div>

    ${beadsStats.projectsData.length === 0
      ? `<div class="card"><div class="card-body"><p class="nil">— no beads databases found in your projects root (set BRAYNEE_PROJECTS_DIR if your repos are not under ~/code) —</p></div></div>`
      : `<div class="beads-toolbar">
      <div class="bd-pills">
        <div class="bd-pill active" data-proj="__all__" onclick="selectBeadsProj(this)">All Projects <span class="bd-badge bd-badge-open">${beadsStats.totalOpen}</span></div>
        ${beadsStats.projectsData.map(p => `<div class="bd-pill" data-proj="${esc(p.name)}" onclick="selectBeadsProj(this)">${esc(p.name)} <span class="bd-badge ${p.open > 0 ? 'bd-badge-open' : 'bd-badge-zero'}">${p.open}</span></div>`).join('')}
      </div>
      <div class="bd-filters">
        <button class="bf bf-active" onclick="filterBeads(this,'open')">Open</button>
        <button class="bf" onclick="filterBeads(this,'closed')">Closed</button>
        <button class="bf" onclick="filterBeads(this,'all')">All</button>
      </div>
    </div>
    <div class="bd-count" id="bd-count"></div>
    <div class="bd-grid" id="bd-grid"></div>
    <div class="bd-pager" id="bd-pager"></div>`}
  </div>`;
}

export function renderBeadsDrawer() {
  return `<div class="bd-drawer-overlay" id="bd-drawer-overlay" onclick="closeBdDrawer(event)">
  <div class="bd-drawer" id="bd-drawer" onclick="event.stopPropagation()">
    <div class="bd-drawer-head">
      <div>
        <div class="bd-id-label" id="bd-drawer-id"></div>
        <div class="bd-drawer-title" id="bd-drawer-title"></div>
      </div>
      <button class="bd-drawer-close" onclick="closeBdDrawer()">✕</button>
    </div>
    <div class="bd-drawer-meta" id="bd-drawer-meta"></div>
    <div class="bd-drawer-body" id="bd-drawer-body"></div>
  </div>
</div>`;
}

export function renderBeadsJS(beadsStats) {
  return `<script>
const BEADS_DATA = ${JSON.stringify(beadsStats.projectsData)};
const BEADS_CURRENT_USER = ${JSON.stringify(beadsStats.currentUser || '')};
let _bdProj = '__all__';
let _bdFilter = 'open';
let _bdPage = 1;
const BD_PAGE_SIZE = 12; // 3 cols × 4 rows — a full page fits with no scroll

function selectBeadsProj(el) {
  document.querySelectorAll('.bd-pill').forEach(i => i.classList.remove('active'));
  el.classList.add('active');
  _bdProj = el.dataset.proj;
  _bdPage = 1;
  renderBeads();
}

function filterBeads(el, status) {
  document.querySelectorAll('.bf').forEach(b => b.classList.remove('bf-active'));
  el.classList.add('bf-active');
  _bdFilter = status;
  _bdPage = 1;
  renderBeads();
}

// Windowed page bar: ‹ Prev  1 2 … 7 8 9 … 20 21  Next ›
function _bdPagerHtml(page, pages) {
  const win = [], add = n => { if (n >= 1 && n <= pages && win.indexOf(n) === -1) win.push(n); };
  add(1); add(2); add(page - 1); add(page); add(page + 1); add(pages - 1); add(pages);
  win.sort((a, b) => a - b);
  let html = '<button onclick="bdGoPage(' + (page - 1) + ')"' + (page <= 1 ? ' disabled' : '') + '>‹ Prev</button>';
  let prev = 0;
  for (const n of win) {
    if (n - prev > 1) html += '<span class="pg-ellipsis">…</span>';
    html += '<button class="pg-num' + (n === page ? ' active' : '') + '" onclick="bdGoPage(' + n + ')">' + n + '</button>';
    prev = n;
  }
  html += '<button onclick="bdGoPage(' + (page + 1) + ')"' + (page >= pages ? ' disabled' : '') + '>Next ›</button>';
  return html;
}

function bdGoPage(n) {
  if (n < 1) return;
  _bdPage = n;
  renderBeads();
  const m = document.querySelector('.main'); if (m) m.scrollTop = 0;
}

function renderBeads() {
  const grid = document.getElementById('bd-grid');
  const count = document.getElementById('bd-count');
  if (!grid) return;
  const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const projsToShow = _bdProj === '__all__' ? BEADS_DATA : BEADS_DATA.filter(p => p.name === _bdProj);
  const issues = [];
  for (const p of projsToShow) {
    if (_bdFilter === 'open' || _bdFilter === 'all')
      (p.openIssues || []).forEach(i => issues.push({ ...i, proj: p.name }));
    if (_bdFilter === 'closed' || _bdFilter === 'all')
      (p.closedIssues || []).forEach(i => issues.push({ ...i, proj: p.name }));
  }
  // Open first, then by priority (P0 = most urgent), then id — so the cards a
  // viewer cares about land at the top-left of the grid.
  const sw = s => s === 'open' ? 0 : s === 'closed' ? 1 : 2;
  const pr = i => { const n = parseInt(i.priority, 10); return isNaN(n) ? 9 : n; };
  issues.sort((a, b) => sw(a.status) - sw(b.status) || pr(a) - pr(b) || String(a.id).localeCompare(String(b.id)));

  const pager = document.getElementById('bd-pager');
  const scope = _bdProj === '__all__' ? ' · all projects' : ' · ' + _bdProj;
  if (!issues.length) {
    if (count) count.textContent = '0 issues' + scope;
    grid.innerHTML = '<div class="bd-empty">— no issues —</div>';
    if (pager) pager.innerHTML = '';
    return;
  }
  const pages = Math.max(1, Math.ceil(issues.length / BD_PAGE_SIZE));
  if (_bdPage > pages) _bdPage = pages;
  if (_bdPage < 1) _bdPage = 1;
  const start = (_bdPage - 1) * BD_PAGE_SIZE;
  const pageIssues = issues.slice(start, start + BD_PAGE_SIZE);
  if (count) count.textContent = 'Showing ' + (start + 1) + '–' + (start + pageIssues.length) + ' of ' + issues.length + scope;
  if (pager) pager.innerHTML = pages > 1 ? _bdPagerHtml(_bdPage, pages) : '';
  grid.innerHTML = pageIssues.map(i => {
    const dot = i.status === 'open'
      ? '<span class="bd-card-dot" style="color:var(--amber)">○</span>'
      : i.status === 'closed'
      ? '<span class="bd-card-dot" style="color:var(--green)">✓</span>'
      : '<span class="bd-card-dot" style="color:var(--red)">×</span>';
    const typeColor = i.type === 'bug' ? 'var(--red)' : i.type === 'feature' ? 'var(--blue)' : 'var(--ink-3)';
    const isMine = BEADS_CURRENT_USER && i.assignee && i.assignee.toLowerCase() === BEADS_CURRENT_USER.toLowerCase();
    const projTag = _bdProj === '__all__' ? '<span class="bd-card-proj">' + esc(i.proj || '') + ' · </span>' : '';
    const payload = JSON.stringify(i).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/"/g,'&quot;');
    return '<div class="bd-card' + (isMine ? ' is-mine' : '') + '" onclick="openBdDrawer(' + payload + ')">'
      + '<div class="bd-card-top">' + dot
      + '<span class="bd-card-id">' + projTag + esc(i.id) + '</span>'
      + (i.type ? '<span class="bd-card-type" style="color:' + typeColor + '">' + esc(i.type) + '</span>' : '')
      + '</div>'
      + '<div class="bd-card-title">' + esc(i.title) + '</div>'
      + '<div class="bd-card-foot">'
      + '<span class="bd-card-pri">P' + (i.priority || '?') + '</span>'
      + '<span' + (isMine ? ' style="color:var(--amber)"' : '') + '>' + (i.assignee ? '@' + esc(i.assignee) : '—') + '</span>'
      + '</div>'
      + '</div>';
  }).join('');
}

function openBdDrawer(issue) {
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const overlay = document.getElementById('bd-drawer-overlay');
  document.getElementById('bd-drawer-id').textContent   = (issue.proj ? issue.proj + '  ·  ' : '') + (issue.id || '');
  document.getElementById('bd-drawer-title').textContent = issue.title || '';

  const statusColor = issue.status === 'open' ? 'var(--amber)' : issue.status === 'closed' ? 'var(--green)' : 'var(--red)';
  const typeColor   = issue.type === 'bug' ? 'var(--red)' : issue.type === 'feature' ? 'var(--blue)' : 'var(--ink-3)';
  const metaChips = [
    ['STATUS',   issue.status  || '—', statusColor],
    ['TYPE',     issue.type    || '—', typeColor],
    ['PRIORITY', 'P' + (issue.priority || '?'), 'var(--ink-2)'],
    ['ASSIGNEE', issue.assignee ? '@' + issue.assignee : '—', BEADS_CURRENT_USER && issue.assignee?.toLowerCase() === BEADS_CURRENT_USER.toLowerCase() ? 'var(--amber)' : 'var(--ink-2)'],
  ];
  if (issue.detail?.owner)   metaChips.push(['OWNER',   issue.detail.owner,   'var(--ink-3)']);
  if (issue.detail?.created) metaChips.push(['CREATED', issue.detail.created, 'var(--ink-3)']);
  if (issue.detail?.updated) metaChips.push(['UPDATED', issue.detail.updated, 'var(--ink-3)']);

  document.getElementById('bd-drawer-meta').innerHTML = metaChips.map(([label, val, color]) =>
    '<span class="bd-meta-chip"><span style="color:var(--ink-3);font-size:8px;letter-spacing:.1em">' + label + '  </span>'
    + '<span style="color:' + color + '">' + esc(val) + '</span></span>'
  ).join('');

  const d = issue.detail;
  let bodyHtml = '';
  if (d) {
    const sections = [
      ['Description', d.description],
      ['Notes',       d.notes],
      ['Acceptance',  d.acceptance],
    ];
    for (const [label, text] of sections) {
      bodyHtml += '<div class="bd-section">'
        + '<div class="bd-section-label">' + label + '</div>'
        + (text
          ? '<div class="bd-section-text">' + esc(text).replace(/\\\\n/g,'<br>').replace(/\\n/g,'<br>') + '</div>'
          : '<div class="bd-section-nil">— none —</div>')
        + '</div>';
    }
  } else {
    bodyHtml = '<div class="bd-section"><div class="bd-section-nil">Detail only available for open issues.</div></div>';
  }
  document.getElementById('bd-drawer-body').innerHTML = bodyHtml;
  overlay.classList.add('open');
  document.onkeydown = e => { if (e.key === 'Escape') closeBdDrawer(); };
}

function closeBdDrawer(e) {
  if (e && e.target !== document.getElementById('bd-drawer-overlay')) return;
  document.getElementById('bd-drawer-overlay').classList.remove('open');
  document.onkeydown = null;
}
</script>`;
}
