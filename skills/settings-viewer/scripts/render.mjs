// Shared render core for the Second Brain Dashboard.
//
// Both delivery modes consume this:
//   - file mode  → generate.mjs loads data once and writes settings-viewer.html
//   - server mode → server.mjs calls loadDashboardData() fresh on every request
//     so the page is always live (never a stale snapshot).
//
// Keeping data-load + buildHtml here (instead of inline in generate.mjs) is what
// lets the server reuse 100% of the panels/data without duplicating any of it.
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { loadClaudeData } from './data/claude.mjs';
import { loadVaultStats } from './data/vault.mjs';
import { loadBeadsStats } from './data/beads.mjs';
import { loadSessions } from './data/sessions.mjs';
import { computeAllHookCmds, computeBrayneeHealth, computeHooksLive } from './data/braynee.mjs';

import { renderCSS, renderTopbar, renderSidebar, renderNavJS } from './html/shell.mjs';
import { renderChartLib, renderChartRuntime } from './html/charts.mjs';
import { esc } from './html/utils.mjs';

import { renderGeneralPanel, renderPermissionsPanel, renderHooksPanel, renderPluginsPanel, renderMcpPanel, renderAgentsPanel, renderRulesPanel, renderClaudeMdPanel } from './panels/config.mjs';
import { renderProjectsPanel, renderSkillUsagePanel, renderInstalledSkillsPanel, renderLocalPluginsPanel, renderPrefsPanel, renderProjectsJS, renderSkillUsageJS } from './panels/data.mjs';
import { renderAnalyticsPanel, renderToolUsagePanel, renderProjectHoursPanel, renderAnalyticsJS, renderToolUsageJS, renderProjectHoursJS } from './panels/insights.mjs';
import { renderBrayneePanel, renderBrayneeJS } from './panels/braynee.mjs';
import { renderBeadsPanel, renderBeadsDrawer, renderBeadsJS } from './panels/beads.mjs';
import { renderSessionsPanel, renderSessionsJS } from './panels/sessions.mjs';

// Plugin metadata — read at runtime so version + author never drift from
// .claude-plugin/plugin.json. render.mjs is at skills/settings-viewer/scripts/
// → up 3 to plugin root → .claude-plugin/plugin.json.
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function loadPluginMeta() {
  let meta = { version: '?', author: { name: '' } };
  try { meta = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')); } catch {}
  return { pluginVersion: meta.version || '?', pluginAuthor: meta.author?.name || '' };
}

// Load every data source the dashboard needs and bundle it into the `d` object
// the panels consume. Called once for file mode; once per request for server
// mode (which is what keeps server-mode data live).
export async function loadDashboardData() {
  const [claudeData, vaultStats, beadsStats, sessionsData] = await Promise.all([
    loadClaudeData(),
    loadVaultStats(),
    loadBeadsStats(),
    loadSessions(),
  ]);

  // Un-mangle Projects-panel names: claude.mjs builds allProjects from encoded dir
  // names (lossy decode), but the sessions loader recovered the real name from each
  // transcript's cwd. Reconcile by encoded dir so `mastra-rag` stops reading `rag`.
  const nameByEncoded = sessionsData.nameByEncoded || {};
  for (const p of claudeData.allProjects || []) {
    if (p.encoded && nameByEncoded[p.encoded]) p.name = nameByEncoded[p.encoded];
  }

  const allHookCmds = computeAllHookCmds(claudeData.s);
  const brayneeHealth = computeBrayneeHealth(claudeData.s, allHookCmds);
  const hooksLive = computeHooksLive();
  const ts = new Date().toLocaleString();
  const { pluginVersion, pluginAuthor } = loadPluginMeta();

  return { ...claudeData, vaultStats, beadsStats, sessionsData, brayneeHealth, hooksLive, ts, pluginVersion, pluginAuthor };
}

// One template, two sources: the interactive local dashboard and a fully
// self-contained, offline-portable artifact (no external fonts, no live-reload)
// that can be shared or dropped into a Claude artifact canvas. `artifact` toggles
// the portability tweaks; the panels + data layer are identical.
export function buildHtml(d, { artifact = false } = {}) {
  // Artifact mode drops the Google Fonts <link> so the file is fully offline —
  // the CSS font stacks fall back to the system monospace/sans gracefully.
  const fontLinks = artifact ? '' : `<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Braynee</title>
${fontLinks}
${renderCSS()}
${renderChartLib()}
</head>
<body>

${renderTopbar(d.acct, d.ts)}

<div class="layout">
${renderSidebar()}

<main class="main">
  ${renderBrayneePanel(d)}
  ${renderGeneralPanel(d)}
  ${renderPermissionsPanel(d)}
  ${renderHooksPanel(d)}
  ${renderPluginsPanel(d)}
  ${renderMcpPanel(d)}
  ${renderAgentsPanel(d)}
  ${renderSessionsPanel(d)}
  ${renderProjectsPanel(d)}
  ${renderSkillUsagePanel(d)}
  ${renderInstalledSkillsPanel(d)}
  ${renderLocalPluginsPanel(d)}
  ${renderPrefsPanel(d)}
  ${renderRulesPanel(d)}
  ${renderClaudeMdPanel(d)}
  ${renderAnalyticsPanel(d)}
  ${renderToolUsagePanel(d)}
  ${renderProjectHoursPanel(d)}
  ${renderBeadsPanel(d.beadsStats)}
</main>
</div>

${renderBeadsDrawer()}

<div class="footer">GENERATED ${esc(d.ts.toUpperCase())} &nbsp;·&nbsp; ${esc(d.acct.organizationName || '')} &nbsp;·&nbsp; BRAYNEE v${esc(d.pluginVersion)}${d.pluginAuthor ? ' · ' + esc(d.pluginAuthor) : ''}${artifact ? ' · PORTABLE ARTIFACT' : ''}</div>

${renderBeadsJS(d.beadsStats)}
${renderSessionsJS(d)}
${renderChartRuntime()}
${renderBrayneeJS(d)}
${renderAnalyticsJS(d)}
${renderToolUsageJS(d)}
${renderProjectHoursJS(d)}
${renderSkillUsageJS(d)}
${renderProjectsJS(d)}
${renderNavJS({ artifact })}
</body>
</html>`;
}
