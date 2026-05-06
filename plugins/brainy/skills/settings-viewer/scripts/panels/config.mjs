import { esc, kvTable, ruleChips, hooksPanel, hookCoveragePanel, voiceCard, installedPluginsGrid, mcpCards, agentsPanel, ALL_HOOK_EVENTS } from '../html/utils.mjs';

export function renderGeneralPanel(d) {
  const { appLaunches, conversations, totalHours, totalProjects, promptsSubmitted, ig, _acct, gen, env, statusLine, voice } = d;
  return `<div id="panel-general" class="panel">
    <div class="section-head">
      <div class="section-title">General</div>
      <div class="section-tag">settings.json + .claude.json</div>
    </div>
    <div class="stats" style="grid-template-columns:repeat(4,1fr)">
      <div class="stat-box"><div class="stat-num">${appLaunches}</div><div class="stat-lbl">App Launches</div></div>
      <div class="stat-box"><div class="stat-num">${conversations}</div><div class="stat-lbl">Conversations</div></div>
      <div class="stat-box"><div class="stat-num">${totalHours}</div><div class="stat-lbl">Hours in Claude Code</div></div>
      <div class="stat-box"><div class="stat-num">${totalProjects}</div><div class="stat-lbl">Projects</div></div>
    </div>
    <div class="stats" style="grid-template-columns:repeat(4,1fr);margin-top:-10px">
      <div class="stat-box"><div class="stat-num" style="color:var(--blue)">${promptsSubmitted}</div><div class="stat-lbl">Prompts Submitted</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--green)">${ig.total_git_commits ?? ig.git_commits ?? '—'}</div><div class="stat-lbl">Git Commits</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--purple)">${_acct.tracked_sessions || '—'}</div><div class="stat-lbl">Tracked Sessions</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--yellow);font-size:18px">${_acct.tracked_messages || '—'}</div><div class="stat-lbl">Tracked Messages</div></div>
    </div>
    <div class="card" style="margin-bottom:14px;border-color:rgba(245,166,35,.25);background:rgba(245,166,35,.04)">
      <div class="card-body" style="font-size:11px;color:var(--ink-2);padding:10px 16px;">
        <strong style="color:var(--amber)">⚠ Spend caveat:</strong> Claude Code only stores <code>lastCost</code> per project — the cost of the most recent session only. No cumulative all-time spend is tracked locally. Check the Anthropic console for true totals.
      </div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><div class="card-head-dot"></div>Core Settings</div>
        <div class="card-body">${kvTable(gen, ['$schema'])}</div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-head-dot"></div>Environment Variables</div>
        <div class="card-body">${kvTable(env, [], true)}</div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>Status Line</div>
      <div class="card-body">${statusLine ? kvTable(statusLine) : `<p class="nil">— not configured —</p>`}</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot" style="background:var(--blue)"></div>Voice</div>
      <div class="card-body">${voiceCard(voice)}</div>
    </div>
  </div>`;
}

export function renderPermissionsPanel(d) {
  const { permissions: p } = d;
  return `<div id="panel-permissions" class="panel">
    <div class="section-head">
      <div class="section-title">Permissions</div>
      <div class="section-tag">allow · ask · deny</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot" style="background:var(--green)"></div>Allow Rules <span style="margin-left:auto;color:var(--green)">${(p.allow||[]).length}</span></div>
      <div class="card-body">${ruleChips(p.allow, 'allow')}</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot" style="background:var(--yellow)"></div>Ask Rules <span style="margin-left:auto;color:var(--yellow)">${(p.ask||[]).length}</span></div>
      <div class="card-body">${ruleChips(p.ask, 'ask')}</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot" style="background:var(--red)"></div>Deny Rules <span style="margin-left:auto;color:var(--red)">${(p.deny||[]).length}</span></div>
      <div class="card-body">${ruleChips(p.deny, 'deny')}</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>Other</div>
      <div class="card-body">${kvTable({ defaultMode: p.defaultMode, additionalDirectories: p.additionalDirectories, disableBypassPermissionsMode: p.disableBypassPermissionsMode, skipDangerousModePermissionPrompt: p.skipDangerousModePermissionPrompt })}</div>
    </div>
  </div>`;
}

export function renderHooksPanel(d) {
  const { hooks } = d;
  return `<div id="panel-hooks" class="panel">
    <div class="section-head">
      <div class="section-title">Hooks</div>
      <div class="section-tag">${Object.keys(hooks).length}/${ALL_HOOK_EVENTS.length} events wired</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot" style="background:var(--green)"></div>Event Coverage</div>
      <div class="card-body">${hookCoveragePanel(hooks)}</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>Hook Details</div>
      <div class="card-body">${hooksPanel(hooks)}</div>
    </div>
  </div>`;
}

export function renderPluginsPanel(d) {
  const { installedPlugins, enabledPlugins } = d;
  return `<div id="panel-plugins" class="panel">
    <div class="section-head">
      <div class="section-title">Plugins</div>
      <div class="section-tag">${Object.keys(installedPlugins).length} installed · ${Object.values(enabledPlugins).filter(Boolean).length} enabled</div>
    </div>
    <div class="card" style="margin-bottom:14px;border-color:rgba(91,192,248,.2);background:rgba(91,192,248,.03)">
      <div class="card-body" style="font-size:11px;color:var(--ink-2);padding:10px 16px;">
        <strong style="color:var(--blue)">Source:</strong> ~/.claude/plugins/installed_plugins.json (${Object.keys(installedPlugins).length} plugins) merged with settings.json enabledPlugins for on/off status.
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>Installed Plugins</div>
      <div class="card-body">${installedPluginsGrid(installedPlugins, enabledPlugins)}</div>
    </div>
  </div>`;
}

export function renderMcpPanel(d) {
  const { sMcp, uMcp, mcpJson } = d;
  return `<div id="panel-mcp" class="panel">
    <div class="section-head">
      <div class="section-title">MCP Servers</div>
      <div class="section-tag">${Object.keys(sMcp).length + Object.keys(uMcp).length + Object.keys(mcpJson).length} total · 3 config locations</div>
    </div>
    <div class="card" style="margin-bottom:14px;border-color:rgba(255,92,92,.2);background:rgba(255,92,92,.03)">
      <div class="card-body" style="font-size:11px;color:var(--ink-2);padding:10px 16px;">
        <strong style="color:var(--red)">🔒 Masked:</strong> ~/.claude/.mcp.json env var values are redacted (***) since they may contain plaintext credentials.
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>~/.claude/settings.json · ${Object.keys(sMcp).length} servers</div>
      <div class="card-body">${mcpCards(sMcp)}</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot" style="background:var(--blue)"></div>~/.claude.json user-scope (claude mcp add --scope user) · ${Object.keys(uMcp).length} servers</div>
      <div class="card-body">${mcpCards(uMcp)}</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot" style="background:var(--purple)"></div>~/.claude/.mcp.json (plugin-written) · ${Object.keys(mcpJson).length} servers · credentials masked</div>
      <div class="card-body">${mcpCards(mcpJson, true)}</div>
    </div>
  </div>`;
}

export function renderAgentsPanel(d) {
  const { customAgents } = d;
  return `<div id="panel-agents" class="panel">
    <div class="section-head">
      <div class="section-title">Agents</div>
      <div class="section-tag">${customAgents.length} custom agents · ~/.claude/agents/</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot" style="background:var(--green)"></div>Custom Agent Definitions</div>
      <div class="card-body">${agentsPanel(customAgents)}</div>
    </div>
  </div>`;
}

export function renderClaudeMdPanel(d) {
  const { claudeMd } = d;
  return `<div id="panel-claudemd" class="panel">
    <div class="section-head">
      <div class="section-title">CLAUDE.md</div>
      <div class="section-tag">user instruction prompt · ~/.claude/CLAUDE.md</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>Raw Source</div>
      <div class="card-body"><pre class="md-source">${esc(claudeMd)}</pre></div>
    </div>
  </div>`;
}
