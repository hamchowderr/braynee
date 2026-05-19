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
      <div class="stat-box"><div class="stat-num" style="color:var(--red)">${beadsStats.assignedToMe}</div><div class="stat-lbl">Mine (@hamchowderr)</div></div>
    </div>

    ${beadsStats.projectsData.length === 0
      ? `<div class="card"><div class="card-body"><p class="nil">— no beads databases found in your projects root (set BRAYNEE_PROJECTS_DIR if your repos are not under ~/code) —</p></div></div>`
      : `<div class="beads-layout">
      <div class="beads-proj-sidebar">
        <div class="beads-proj-item active" data-proj="__all__" onclick="selectBeadsProj(this)">
          <span class="bd-proj-name" style="font-weight:500">All Projects</span>
          <span class="bd-badge bd-badge-open">${beadsStats.totalOpen}</span>
        </div>
        ${beadsStats.projectsData.map(p => `
        <div class="beads-proj-item" data-proj="${esc(p.name)}" onclick="selectBeadsProj(this)">
          <span class="bd-proj-name">${esc(p.name)}</span>
          <span class="bd-badge ${p.open > 0 ? 'bd-badge-open' : 'bd-badge-zero'}">${p.open}</span>
        </div>`).join('')}
      </div>
      <div class="beads-main">
        <div class="beads-filters">
          <button class="bf bf-active" onclick="filterBeads(this,'open')">Open</button>
          <button class="bf" onclick="filterBeads(this,'closed')">Closed</button>
          <button class="bf" onclick="filterBeads(this,'all')">All</button>
          <span id="bd-filter-label" style="margin-left:auto;font-size:10px;color:var(--ink-3)"></span>
        </div>
        <div class="bt-head">
          <span class="bt-cell" style="width:20px"></span>
          <span class="bt-cell" style="flex:0 0 160px">ID</span>
          <span class="bt-cell" style="flex:1">Title</span>
          <span class="bt-cell" style="width:64px">Type</span>
          <span class="bt-cell" style="width:32px">P</span>
          <span class="bt-cell" style="width:130px">Assignee</span>
        </div>
        <div id="bd-rows"></div>
      </div>
    </div>`}
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
let _bdProj = '__all__';
let _bdFilter = 'open';

function selectBeadsProj(el) {
  document.querySelectorAll('.beads-proj-item').forEach(i => i.classList.remove('active'));
  el.classList.add('active');
  _bdProj = el.dataset.proj;
  renderBeads();
}

function filterBeads(el, status) {
  document.querySelectorAll('.bf').forEach(b => b.classList.remove('bf-active'));
  el.classList.add('bf-active');
  _bdFilter = status;
  renderBeads();
}

function renderBeads() {
  const rows = document.getElementById('bd-rows');
  const label = document.getElementById('bd-filter-label');
  if (!rows) return;
  const projsToShow = _bdProj === '__all__' ? BEADS_DATA : BEADS_DATA.filter(p => p.name === _bdProj);
  const issues = [];
  for (const p of projsToShow) {
    if (_bdFilter === 'open' || _bdFilter === 'all')
      (p.openIssues || []).forEach(i => issues.push({ ...i, proj: p.name }));
    if (_bdFilter === 'closed' || _bdFilter === 'all')
      (p.closedIssues || []).forEach(i => issues.push({ ...i, proj: p.name }));
  }
  if (label) label.textContent = issues.length + ' issue' + (issues.length !== 1 ? 's' : '');
  if (!issues.length) {
    rows.innerHTML = '<div style="padding:20px 16px;font-size:11px;color:var(--ink-3)">— no issues —</div>';
    return;
  }
  rows.innerHTML = issues.map((i, idx) => {
    const dot = i.status === 'open'
      ? '<span style="color:var(--amber)">○</span>'
      : i.status === 'closed'
      ? '<span style="color:var(--green)">✓</span>'
      : '<span style="color:var(--red)">×</span>';
    const typeCls = i.type === 'bug' ? 'color:var(--red)' : i.type === 'feature' ? 'color:var(--blue)' : 'color:var(--ink-3)';
    const isMine = i.assignee === 'hamchowderr';
    const projPrefix = _bdProj === '__all__' ? '<span style="color:var(--ink-3);font-size:9px">' + (i.proj||'') + ' </span>' : '';
    const hasDetail = i.detail !== null && i.detail !== undefined;
    return '<div class="bt-row" onclick="openBdDrawer(' + JSON.stringify(i).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/"/g,'&quot;') + ')" title="' + (hasDetail ? 'Click to view details' : '') + '">'
      + '<span class="bt-cell" style="width:20px;font-size:14px">' + dot + '</span>'
      + '<span class="bt-cell" style="flex:0 0 160px"><span class="bd-id">' + projPrefix + (i.id||'') + '</span></span>'
      + '<span class="bt-cell" style="flex:1;color:var(--ink)">' + (i.title||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>'
      + '<span class="bt-cell" style="width:64px;' + typeCls + '">' + (i.type||'') + '</span>'
      + '<span class="bt-cell" style="width:32px;color:var(--ink-3)">P' + (i.priority||'?') + '</span>'
      + '<span class="bt-cell" style="width:130px;' + (isMine ? 'color:var(--amber)' : 'color:var(--ink-3)') + '">' + (i.assignee ? '@' + i.assignee : '—') + '</span>'
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
    ['ASSIGNEE', issue.assignee ? '@' + issue.assignee : '—', issue.assignee === 'hamchowderr' ? 'var(--amber)' : 'var(--ink-2)'],
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
          ? '<div class="bd-section-text">' + esc(text).replace(/\\n/g,'<br>').replace(/\n/g,'<br>') + '</div>'
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
