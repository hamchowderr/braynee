export const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

export const badge = v => v === true
  ? `<span class="chip chip-on">ON</span>`
  : v === false
  ? `<span class="chip chip-off">OFF</span>`
  : `<span class="chip chip-val">${esc(v)}</span>`;

export function kvTable(obj, skip = [], maskValues = false) {
  const rows = Object.entries(obj ?? {}).filter(([k]) => !skip.includes(k));
  if (!rows.length) return `<p class="nil">— empty —</p>`;
  return `<table class="kv">${rows.map(([k, v]) => {
    let val;
    if (maskValues && typeof v === 'string' && v.length > 0) {
      val = `<span class="scalar" style="color:var(--ink-3);font-style:italic">••••••••</span>`;
    } else if (typeof v === 'object' && v !== null) {
      val = `<pre class="json-val">${esc(JSON.stringify(v, null, 2))}</pre>`;
    } else if (typeof v === 'boolean') {
      val = badge(v);
    } else {
      val = `<span class="scalar">${esc(String(v))}</span>`;
    }
    return `<tr><td class="prop">${esc(k)}</td><td class="val-cell">${val}</td></tr>`;
  }).join('')}</table>`;
}

export function ruleChips(arr = [], kind) {
  if (!arr.length) return `<p class="nil">— none —</p>`;
  return `<div class="chips">${arr.map(r => `<span class="chip chip-${kind}">${esc(r)}</span>`).join('')}</div>`;
}

export function hooksPanel(h) {
  if (!Object.keys(h).length) return `<p class="nil">— no hooks configured —</p>`;
  return Object.entries(h).map(([ev, matchers]) => {
    const items = matchers.flatMap(m => (m.hooks || []).map(hk => ({ mat: m.matcher || '*', cmd: hk.command })));
    return `<div class="hook-block">
      <div class="hook-ev-label">${esc(ev)}</div>
      ${items.map(i => `<div class="hook-row">
        <span class="hook-mat">${esc(i.mat || '*')}</span>
        <code class="hook-cmd">${esc(i.cmd)}</code>
      </div>`).join('')}
    </div>`;
  }).join('');
}

export const ALL_HOOK_EVENTS = [
  'SessionStart','SessionEnd','InstructionsLoaded',
  'UserPromptSubmit','UserPromptExpansion',
  'PreToolUse','PostToolUse','PostToolUseFailure','PostToolBatch',
  'SubagentStart','SubagentStop','TeammateIdle',
  'TaskCreated','TaskCompleted',
  'PermissionRequest','PermissionDenied',
  'PreCompact','PostCompact',
  'Stop','StopFailure',
  'WorktreeCreate','WorktreeRemove',
  'Elicitation','ElicitationResult',
  'ConfigChange','CwdChanged','FileChanged',
  'Notification',
];

export function hookCoveragePanel(h) {
  const wired = new Set(Object.keys(h));
  const total = ALL_HOOK_EVENTS.length;
  const covered = ALL_HOOK_EVENTS.filter(e => wired.has(e)).length;
  const pct = Math.round((covered / total) * 100);
  const tiles = ALL_HOOK_EVENTS.map(ev => {
    const on = wired.has(ev);
    const count = on ? (h[ev] || []).reduce((a, m) => a + (m.hooks || []).length, 0) : 0;
    return `<div class="hcev-tile ${on ? 'hcev-on' : 'hcev-off'}" title="${ev}${on ? ` (${count} hook${count !== 1 ? 's' : ''})` : ' — not configured'}">
      <div class="hcev-dot ${on ? 'dot-on' : 'dot-off'}"></div>
      <div class="hcev-name">${esc(ev)}</div>
      ${on ? `<div class="hcev-ct">${count}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="hcov-summary">
    <div class="hcov-bar-wrap"><div class="hcov-bar" style="width:${pct}%"></div></div>
    <span class="hcov-label" title="How many of Claude Code's ${total} hook lifecycle events have at least one hook configured">${covered} of ${total} hook events have a hook &nbsp;·&nbsp; ${pct}% coverage</span>
  </div>
  <div class="hcev-grid">${tiles}</div>`;
}

export function voiceCard(v) {
  if (!v || !Object.keys(v).length) return `<p class="nil">— not configured —</p>`;
  return `<div class="voice-grid">
    <div class="voice-item">
      <div class="voice-lbl">Enabled</div>
      <div class="voice-val">${badge(v.enabled ?? false)}</div>
    </div>
    <div class="voice-item">
      <div class="voice-lbl">Mode</div>
      <div class="voice-val"><span class="chip chip-val">${esc(v.mode || '—')}</span></div>
    </div>
    <div class="voice-item">
      <div class="voice-lbl">Auto Submit</div>
      <div class="voice-val">${badge(v.autoSubmit ?? false)}</div>
    </div>
  </div>`;
}

export function pluginGrid(pl) {
  const ent = Object.entries(pl);
  if (!ent.length) return `<p class="nil">— none —</p>`;
  return `<div class="plugin-grid">${ent.map(([name, on]) => {
    const [nm, mkt] = name.split('@');
    return `<div class="plugin-tile ${on ? '' : 'plugin-off'}">
      <div class="plugin-dot ${on ? 'dot-on' : 'dot-off'}"></div>
      <div class="plugin-nm">${esc(nm)}</div>
      <div class="plugin-mkt">@${esc(mkt || '')}</div>
    </div>`;
  }).join('')}</div>`;
}

export function projectRows(projectList) {
  const sorted = [...projectList].sort((a, b) => {
    if (b.sessionCount !== a.sessionCount) return b.sessionCount - a.sessionCount;
    if (b.sizeBytes !== a.sizeBytes) return b.sizeBytes - a.sizeBytes;
    return a.name.localeCompare(b.name);
  });
  const maxSize = Math.max(...sorted.map(x => x.sizeBytes), 1);
  return `<div class="proj-list">${sorted.map((x, i) => {
    const pct = Math.round((x.sizeBytes / maxSize) * 100);
    const active = x.sessionCount > 0;
    const sizeMB = (x.sizeBytes / 1024 / 1024).toFixed(1);
    return `<div class="proj-row" style="grid-template-columns:28px 1fr 120px 48px 52px 64px">
      <span class="proj-rank" style="${active ? '' : 'color:var(--ink-3)'}">${active ? String(i+1).padStart(2,'0') : '—'}</span>
      <span class="proj-nm" title="${esc(x.path)}">${esc(x.name)}</span>
      <div class="proj-bar-wrap"><div class="proj-bar" style="width:${pct}%;background:${active ? 'var(--amber)' : 'var(--line-2)'}"></div></div>
      <span class="proj-cost" style="color:var(--ink-2);text-align:right;font-size:10px">${sizeMB}MB</span>
      <span class="proj-cost" style="color:var(--blue);text-align:right">${x.sessionCount > 0 ? x.sessionCount+'s' : '—'}</span>
      <span class="proj-cost" style="color:${x.lastCost > 0 ? 'var(--green)' : 'var(--ink-3)'};text-align:right">${x.lastCost > 0 ? '$'+x.lastCost.toFixed(2) : ''}</span>
    </div>`;
  }).join('')}</div>`;
}

export function maskCredentials(cfg) {
  const m = JSON.parse(JSON.stringify(cfg));
  if (m.env) for (const k of Object.keys(m.env)) m.env[k] = '***';
  if (m.args) m.args = m.args.map(a => /password|token|secret|key|pwd|auth/i.test(a) ? '***' : a);
  return m;
}

export function mcpCards(m, masked = false) {
  const ent = Object.entries(m);
  if (!ent.length) return `<p class="nil">— none configured —</p>`;
  return `<div class="mcp-cards">${ent.map(([name, rawCfg]) => {
    const cfg = masked ? maskCredentials(rawCfg) : rawCfg;
    const envEntries = cfg.env ? Object.entries(cfg.env) : [];
    return `<div class="mcp-card">
      <div class="mcp-name">${esc(name)}</div>
      <div class="mcp-type">${esc(cfg.type || 'stdio')}</div>
      <code class="mcp-cmd">${esc(cfg.command || cfg.url || '')}${cfg.args?.length ? ' ' + cfg.args.join(' ') : ''}</code>
      ${envEntries.length ? `<div class="mcp-env">${envEntries.map(([k,v]) => `<span class="mcp-env-key">${esc(k)}</span>=<span class="mcp-env-val">${esc(v)}</span>`).join('  ')}</div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

export function installedPluginsGrid(installed, enabled) {
  const entries = Object.entries(installed);
  if (!entries.length) return pluginGrid(enabled);
  return `<div class="plugin-grid">${entries.map(([id, info]) => {
    const isEnabled = enabled[id] !== false;
    const [nm, mkt] = id.split('@');
    return `<div class="plugin-tile ${isEnabled ? '' : 'plugin-off'}">
      <div class="plugin-dot ${isEnabled ? 'dot-on' : 'dot-off'}"></div>
      <div class="plugin-nm">${esc(nm)}</div>
      <div class="plugin-mkt">@${esc(mkt || '')}</div>
      ${info.version ? `<div style="font-size:9px;color:var(--ink-3);margin-top:2px">v${esc(info.version)}</div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

export function agentsPanel(agents) {
  if (!agents.length) return `<p class="nil">— no custom agents found in ~/.claude/agents/ —</p>`;
  return `<div class="agent-list">${agents.map(a => `
    <div class="agent-card">
      <div class="agent-name">${esc(a.name)}</div>
      <div class="agent-file">${esc(a.file)}</div>
      ${a.desc ? `<div class="agent-desc">${esc(a.desc)}</div>` : ''}
    </div>`).join('')}</div>`;
}

export function rankBars(obj, color = 'var(--amber)', limit = 20) {
  if (!obj || !Object.keys(obj).length) return `<p class="nil">— no data —</p>`;
  const ent = Object.entries(obj).sort(([,a],[,b]) => b - a).slice(0, limit);
  const max = ent[0][1] || 1;
  return `<div class="skill-list">${ent.map(([k, v]) => {
    const pct = Math.round((v / max) * 100);
    return `<div class="skill-row">
      <span class="skill-nm">${esc(k)}</span>
      <div class="skill-bar-wrap"><div class="skill-bar" style="width:${pct}%;background:${color}"></div></div>
      <span class="skill-ct" style="color:${color}">${v}</span>
    </div>`;
  }).join('')}</div>`;
}

export function insightsProjRows(iProjects) {
  if (!iProjects || !Object.keys(iProjects).length) return `<p class="nil">— no data —</p>`;
  const ent = Object.entries(iProjects).sort(([,a],[,b]) => b.total_hours - a.total_hours);
  const maxH = ent[0]?.[1]?.total_hours || 1;
  return `<div class="proj-list">${ent.map(([nm, x], i) => {
    const pct = Math.round((x.total_hours / maxH) * 100);
    return `<div class="proj-row" style="grid-template-columns:28px 1fr 140px 56px 72px">
      <span class="proj-rank">${String(i+1).padStart(2,'0')}</span>
      <span class="proj-nm">${esc(nm)}</span>
      <div class="proj-bar-wrap" style="width:100%"><div class="proj-bar" style="width:${pct}%;background:var(--purple)"></div></div>
      <span class="proj-cost" style="color:var(--purple);text-align:right">${(x.total_hours||0).toFixed(0)}h</span>
      <span class="proj-cost" style="color:var(--ink-3);text-align:right">${x.session_count||0} sess</span>
    </div>`;
  }).join('')}</div>`;
}

export function installedSkillsGrid(skills) {
  if (!skills.length) return `<p class="nil">— no skills found —</p>`;

  // No use-counts here on purpose — invocation frequency lives on the Skill Usage
  // page; this is the plain catalog (name · id · description) to avoid duplication.
  function skillCards(sks) {
    return sks.map(sk => {
      const desc = sk.desc || '';
      return `<div class="iskill-card">
        <div class="iskill-top">
          <span class="iskill-name">${esc(sk.name)}</span>
        </div>
        <div class="iskill-id">${esc(sk.id)}</div>
        <div class="iskill-desc">${esc(desc.slice(0, 160))}${desc.length > 160 ? '…' : ''}</div>
      </div>`;
    }).join('');
  }

  const groups = {};
  for (const sk of skills) {
    if (!groups[sk.source]) groups[sk.source] = [];
    groups[sk.source].push(sk);
  }

  const localSks = groups['local'] || [];
  const pluginSources = Object.keys(groups).filter(s => s !== 'local').sort();
  const parts = [];

  if (localSks.length) {
    parts.push(`<div class="iskill-group">
      <div class="iskill-group-head">Local · ~/.claude/skills/ · ${localSks.length} skills</div>
      <div class="iskill-grid">${skillCards(localSks)}</div>
    </div>`);
  }

  for (const src of pluginSources) {
    const sks = groups[src];
    parts.push(`<div class="iskill-group">
      <div class="iskill-group-head">${esc(src)} plugin · ${sks.length} skills</div>
      <div class="iskill-grid">${skillCards(sks)}</div>
    </div>`);
  }

  return parts.join('');
}

export function localPluginsPanel(plugins) {
  if (!plugins.length) return `<p class="nil">— no local plugins found —</p>`;
  return plugins.map(pl => `
    <div class="lplugin-card">
      <div class="lplugin-header">
        <span class="lplugin-name">${esc(pl.name)}</span>
        <span class="lplugin-id">${esc(pl.id)}</span>
      </div>
      <div class="lplugin-desc">${esc(pl.desc)}</div>
      ${pl.commands.length ? `<div class="lplugin-cmds">${pl.commands.map(cmd => `<span class="chip chip-val">${esc(cmd)}</span>`).join('')}</div>` : ''}
    </div>`).join('');
}

export function skillBars(u) {
  const ent = Object.entries(u).sort(([, a], [, b]) => b.usageCount - a.usageCount).slice(0, 20);
  if (!ent.length) return `<p class="nil">— no usage data —</p>`;
  const max = ent[0][1].usageCount;
  return `<div class="skill-list">${ent.map(([nm, d]) => {
    const pct = Math.round((d.usageCount / max) * 100);
    return `<div class="skill-row">
      <span class="skill-nm">${esc(nm)}</span>
      <div class="skill-bar-wrap"><div class="skill-bar" style="width:${pct}%"></div></div>
      <span class="skill-ct">${d.usageCount}</span>
    </div>`;
  }).join('')}</div>`;
}
