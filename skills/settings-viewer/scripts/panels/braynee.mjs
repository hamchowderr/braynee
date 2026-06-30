import { esc } from '../html/utils.mjs';
import { chartBox } from '../html/charts.mjs';

// The Braynee panel IS the Overview/Today landing (cp-dgu.2): one screen that
// aggregates vault + beads + sessions + spend, plus the plugin-health banners and
// the skill-command reference. It stays the default panel, so no nav rewiring.
export function renderBrayneePanel(d) {
  const {
    vaultStats, beadsStats, brayneeHealth, hooksLive, totalProjects, totalHours,
    allProjects, sessionsData, ts, pluginVersion, pluginAuthor,
  } = d;

  const hl = hooksLive || { state: 'missing', live: false, lastBeat: null };
  const hlColor = hl.live ? 'var(--green)' : 'var(--red)';
  const hlLabel = hl.state === 'live' ? 'YES'
    : hl.state === 'stale' ? 'STALE'
    : hl.state === 'missing' ? 'NO — INERT'
    : 'UNKNOWN';
  const hlDetail = hl.state === 'live'
    ? `last SessionStart ${hl.lastBeat ? new Date(hl.lastBeat).toLocaleString() : ''}`
    : hl.state === 'stale'
      ? `no SessionStart in over 24h (last ${hl.lastBeat ? new Date(hl.lastBeat).toLocaleString() : '?'}) — hooks may be disabled`
      : hl.state === 'missing'
        ? 'heartbeat sentinel never written — disableAllHooks, a managed policy, or a Claude Code too old for plugin hooks. Every Braynee lifecycle guarantee is silently off.'
        : 'heartbeat file unreadable';

  const para = vaultStats.para || { projects: 0, areas: 0, resources: 0, archives: 0 };
  const totalSpend = (allProjects || []).reduce((s, p) => s + (p.lastCost || 0), 0);
  const recent = (sessionsData?.sessions || []).slice(0, 6);
  const fmtDate = ms => { try { return new Date(ms).toISOString().slice(0, 10); } catch { return '—'; } };

  const kpi = (num, lbl, color, sub) =>
    `<div class="stat-box"><div class="stat-num" style="color:${color}">${num}${sub ? `<span style="font-size:15px">${sub}</span>` : ''}</div><div class="stat-lbl">${lbl}</div></div>`;

  return `<div id="panel-braynee" class="panel active">
    <div class="section-head">
      <div class="section-title">Overview</div>
      <div class="section-tag">Braynee v${esc(pluginVersion || '?')} · today at a glance${pluginAuthor ? ' · ' + esc(pluginAuthor) : ''}</div>
    </div>

    <div class="stats" style="grid-template-columns:repeat(4,1fr)">
      ${kpi(beadsStats.totalOpen, 'Open Beads', 'var(--amber)')}
      ${kpi(beadsStats.assignedToMe, `Mine${beadsStats.currentUser ? ` (@${esc(beadsStats.currentUser)})` : ''}`, 'var(--red)')}
      ${kpi(vaultStats.sessionCount, 'Sessions Logged', 'var(--blue)')}
      ${kpi(totalHours ?? '—', 'Hours Tracked', 'var(--green)', totalHours && totalHours !== '—' ? 'h' : '')}
    </div>
    <div class="stats" style="grid-template-columns:repeat(4,1fr)">
      ${kpi(vaultStats.inboxCount, 'Inbox Items', vaultStats.inboxCount > 0 ? 'var(--amber)' : 'var(--green)')}
      ${kpi(vaultStats.taskCount ?? 0, 'Open Tasks', 'var(--purple)')}
      ${kpi(totalProjects, 'Projects', 'var(--blue)')}
      ${kpi(totalSpend > 0 ? '$' + totalSpend.toFixed(2) : '—', 'Recent Spend', 'var(--green)')}
    </div>

    ${brayneeHealth.missing > 0
      ? `<div style="padding:10px 14px;background:rgba(255,92,92,.06);border:1px solid rgba(255,92,92,.2);font-size:11px;color:var(--red);margin-bottom:16px">
           ○ ${brayneeHealth.missing} feature${brayneeHealth.missing > 1 ? 's' : ''} not installed — run <span style="color:var(--amber);font-family:var(--mo)">python3 skills/setup/scripts/settings-writer.py apply --yes</span> or use <span style="color:var(--amber);font-family:var(--mo)">/setup</span> to complete setup
         </div>`
      : `<div style="padding:10px 14px;background:rgba(61,220,132,.06);border:1px solid rgba(61,220,132,.2);font-size:11px;color:var(--green);margin-bottom:16px">
           ✓ All ${brayneeHealth.total} features installed and active
         </div>`
    }

    <div style="padding:10px 14px;background:${hl.live ? 'rgba(61,220,132,.06)' : 'rgba(255,92,92,.06)'};border:1px solid ${hl.live ? 'rgba(61,220,132,.2)' : 'rgba(255,92,92,.2)'};font-size:11px;color:${hlColor};margin-bottom:16px">
      ${hl.live ? '✓' : '○'} Hooks live? <strong>${esc(hlLabel)}</strong> &nbsp;·&nbsp; <span style="color:var(--ink-3)">${esc(hlDetail)}</span>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--amber)"></div>Open Beads by Priority</div>
        <div class="card-body">${beadsStats.totalOpen > 0 ? chartBox('bv-bd-priority', 200) : `<p class="nil">— no open issues —</p>`}</div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--blue)"></div>Open Beads by Type</div>
        <div class="card-body">${beadsStats.totalOpen > 0 ? chartBox('bv-bd-type', 200) : `<p class="nil">— no open issues —</p>`}</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--purple)"></div>Recent Sessions</div>
        <div class="card-body">
          ${recent.length ? `<div class="skill-list">${recent.map(s => `
            <div class="skill-row" style="grid-template-columns:74px 1fr">
              <span class="proj-rank" style="font-family:var(--mo);font-size:10px">${fmtDate(s.mtimeMs)}</span>
              <span style="min-width:0">
                <span style="color:var(--ink);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">${esc(s.preview || '(no preview)')}</span>
                <span style="color:var(--blue);font-size:9px">${esc(s.project || '')}</span>
              </span>
            </div>`).join('')}</div>` : `<p class="nil">— no sessions —</p>`}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--green)"></div>Vault</div>
        <div class="card-body"><table class="kv">
          <tr><td class="prop">path</td><td class="val-cell"><span class="scalar" style="font-size:10px;color:var(--ink-3)">${esc(vaultStats.vaultPath || '(unresolved)')}</span></td></tr>
          <tr><td class="prop">inbox</td><td class="val-cell"><span class="scalar" style="${vaultStats.inboxCount > 0 ? 'color:var(--amber)' : 'color:var(--green)'}">${vaultStats.inboxCount} item${vaultStats.inboxCount !== 1 ? 's' : ''}</span></td></tr>
          <tr><td class="prop">tasks</td><td class="val-cell"><span class="scalar">${vaultStats.taskCount ?? 0}</span></td></tr>
          <tr><td class="prop">PARA notes</td><td class="val-cell"><span class="scalar" style="font-size:11px">Projects ${para.projects} · Areas ${para.areas} · Resources ${para.resources} · Archives ${para.archives}</span></td></tr>
        </table></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><div class="card-head-dot" style="background:var(--purple)"></div>Skill Commands</div>
      <div class="card-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0">
          ${[
            ['/setup',        'Onboarding wizard — vault scaffolding + hook install'],
            ['/daily',        'Open or create today\'s daily note'],
            ['/tasks',        'Task management via TaskNotes'],
            ['/clients',      'Client CRM — context, logs, call prep'],
            ['/recap',        'Search past sessions via QMD'],
            ['/sessions',     'Export current session to Obsidian'],
            ['/query',        'Vault search (BM25 + semantic)'],
            ['/health',       'Four Cs system audit'],
            ['/zettelkasten', 'Create or link atomic knowledge notes'],
          ].map(([cmd, desc], i) => `
            <div style="display:flex;align-items:flex-start;gap:10px;padding:7px 8px;${i % 2 === 0 ? 'background:var(--bg-3);' : ''}border-radius:3px">
              <span style="font-family:var(--mo);font-size:11px;color:var(--amber);white-space:nowrap;min-width:110px">${cmd}</span>
              <span style="font-size:11px;color:var(--ink-3);line-height:1.4">${desc}</span>
            </div>`).join('')}
        </div>
      </div>
    </div>
  </div>`;
}

// Donuts for the Overview's beads breakdown — registered lazily and fired by nav()
// when the panel is visible (a hidden-panel canvas measures 0×0).
export function renderBrayneeJS(d) {
  const bd = d.beadsStats?.breakdown || { priority: {}, type: {} };
  const data = { priority: bd.priority || {}, type: bd.type || {} };
  return `<script>
(function(){
  if(!window.bvChart){ return; }
  var D = ${JSON.stringify(data).replace(/</g, '\\u003c')};
  function ent(o){ return Object.entries(o||{}).sort(function(a,b){return b[1]-a[1];}); }
  function donut(id, o){ var e=ent(o); if(!e.length) return;
    bvChart(id, {
      type:'doughnut',
      data:{ labels:e.map(function(x){return x[0];}), datasets:[{ data:e.map(function(x){return x[1];}), backgroundColor:window._bvPalette, borderWidth:2, borderColor:_bvTok('--bg-3') }] },
      options:{ cutout:'60%', plugins:{ legend:{ position:'bottom', labels:{ boxWidth:8, boxHeight:8, usePointStyle:true, padding:10, font:{ size:9 } } } } }
    });
  }
  var prev = window._bvPanelRenderers['braynee'];
  window._bvPanelRenderers['braynee'] = function(){ if(prev) prev();
    donut('bv-bd-priority', D.priority);
    donut('bv-bd-type', D.type);
  };
})();
</script>`;
}
