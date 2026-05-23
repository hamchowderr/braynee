import { esc, kvTable } from '../html/utils.mjs';

export function renderBrayneePanel(d) {
  const { vaultStats, beadsStats, brayneeHealth, hooksLive, totalProjects, acct, ts, pluginVersion, pluginAuthor } = d;

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

  return `<div id="panel-braynee" class="panel active">
    <div class="section-head">
      <div class="section-title">Braynee</div>
      <div class="section-tag">v${esc(pluginVersion || '?')} · second-brain plugin${pluginAuthor ? ' · ' + esc(pluginAuthor) : ''}</div>
    </div>

    <div class="stats" style="grid-template-columns:repeat(4,1fr)">
      <div class="stat-box">
        <div class="stat-num" style="color:var(--amber)">${vaultStats.inboxCount}</div>
        <div class="stat-lbl">Inbox Items</div>
      </div>
      <div class="stat-box">
        <div class="stat-num" style="color:var(--blue)">${vaultStats.sessionCount}</div>
        <div class="stat-lbl">Sessions Logged</div>
      </div>
      <div class="stat-box">
        <div class="stat-num" style="color:var(--red)">${beadsStats.assignedToMe}</div>
        <div class="stat-lbl">Issues Assigned</div>
      </div>
      <div class="stat-box">
        <div class="stat-num" style="color:${brayneeHealth.missing === 0 ? 'var(--green)' : 'var(--red)'}">${brayneeHealth.active}/${brayneeHealth.total}</div>
        <div class="stat-lbl">Features On</div>
      </div>
    </div>

    ${brayneeHealth.missing > 0
      ? `<div style="padding:10px 14px;background:rgba(255,92,92,.06);border:1px solid rgba(255,92,92,.2);font-size:11px;color:var(--red);margin-bottom:16px">
           ○ ${brayneeHealth.missing} feature${brayneeHealth.missing > 1 ? 's' : ''} not installed — run <span style="color:var(--amber);font-family:var(--mo)">python3 skills/setup/scripts/settings-writer.py apply --yes</span> or use <span style="color:var(--amber);font-family:var(--mo)">/setup</span> to complete setup
         </div>`
      : `<div style="padding:10px 14px;background:rgba(61,220,132,.06);border:1px solid rgba(61,220,132,.2);font-size:11px;color:var(--green);margin-bottom:16px">
           ✓ All features installed and active
         </div>`
    }

    <div style="padding:10px 14px;background:${hl.live ? 'rgba(61,220,132,.06)' : 'rgba(255,92,92,.06)'};border:1px solid ${hl.live ? 'rgba(61,220,132,.2)' : 'rgba(255,92,92,.2)'};font-size:11px;color:${hlColor};margin-bottom:16px">
      ${hl.live ? '✓' : '○'} Hooks live? <strong>${esc(hlLabel)}</strong> &nbsp;·&nbsp; <span style="color:var(--ink-3)">${esc(hlDetail)}</span>
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

    <div class="grid-2" style="margin-top:16px">
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--amber)"></div>Vault</div>
        <div class="card-body"><table class="kv">
          <tr><td class="prop">path</td><td class="val-cell"><span class="scalar" style="font-size:10px;color:var(--ink-3)">${esc(vaultStats.vaultPath || '(unresolved)')}</span></td></tr>
          <tr><td class="prop">inbox</td><td class="val-cell"><span class="scalar" style="${vaultStats.inboxCount > 0 ? 'color:var(--amber)' : 'color:var(--green)'}">${vaultStats.inboxCount} item${vaultStats.inboxCount !== 1 ? 's' : ''}</span></td></tr>
          <tr><td class="prop">sessions</td><td class="val-cell"><span class="scalar">${vaultStats.sessionCount} total</span></td></tr>
          <tr><td class="prop">projects</td><td class="val-cell"><span class="scalar">${totalProjects} tracked</span></td></tr>
        </table></div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--blue)"></div>Beads Summary</div>
        <div class="card-body"><table class="kv">
          <tr><td class="prop">workspaces</td><td class="val-cell"><span class="scalar">${beadsStats.workspaces}</span></td></tr>
          <tr><td class="prop">open issues</td><td class="val-cell"><span class="scalar" style="${beadsStats.totalOpen > 0 ? 'color:var(--amber)' : 'color:var(--green)'}">${beadsStats.totalOpen}</span></td></tr>
          <tr><td class="prop">assigned to me</td><td class="val-cell"><span class="scalar" style="${beadsStats.assignedToMe > 0 ? 'color:var(--red)' : 'color:var(--ink-3)'}">${beadsStats.assignedToMe}</span></td></tr>
          <tr><td class="prop">active projects</td><td class="val-cell"><span class="scalar">${beadsStats.activeProjects}</span></td></tr>
        </table></div>
      </div>
    </div>
  </div>`;
}
