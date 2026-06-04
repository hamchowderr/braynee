import { writeFileSync, mkdirSync, statSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { loadClaudeData } from './data/claude.mjs';
import { loadVaultStats } from './data/vault.mjs';
import { loadBeadsStats } from './data/beads.mjs';
import { computeAllHookCmds, computeBrayneeHealth, computeHooksLive } from './data/braynee.mjs';

import { renderCSS, renderTopbar, renderSidebar, renderNavJS } from './html/shell.mjs';
import { esc } from './html/utils.mjs';

import { renderGeneralPanel, renderPermissionsPanel, renderHooksPanel, renderPluginsPanel, renderMcpPanel, renderAgentsPanel, renderRulesPanel, renderClaudeMdPanel } from './panels/config.mjs';
import { renderProjectsPanel, renderSkillUsagePanel, renderInstalledSkillsPanel, renderLocalPluginsPanel, renderPrefsPanel } from './panels/data.mjs';
import { renderAnalyticsPanel, renderToolUsagePanel, renderProjectHoursPanel } from './panels/insights.mjs';
import { renderBrayneePanel } from './panels/braynee.mjs';
import { renderBeadsPanel, renderBeadsDrawer, renderBeadsJS } from './panels/beads.mjs';

const home = homedir();
const outDir = join(home, '.claude', 'temp');
const outPath = join(outDir, 'settings-viewer.html');
mkdirSync(outDir, { recursive: true });

// Load all data in parallel
const [claudeData, vaultStats, beadsStats] = await Promise.all([
  loadClaudeData(),
  loadVaultStats(),
  loadBeadsStats(),
]);

const allHookCmds = computeAllHookCmds(claudeData.s);
const brayneeHealth = computeBrayneeHealth(claudeData.s, allHookCmds);
const hooksLive = computeHooksLive();
const ts = new Date().toLocaleString();

// Plugin metadata — read at runtime so version + author never drift from
// .claude-plugin/plugin.json. generate.mjs is at skills/settings-viewer/scripts/
// → up 3 to plugin root → .claude-plugin/plugin.json.
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let pluginMeta = { version: '?', author: { name: '' } };
try { pluginMeta = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')); } catch {}
const pluginVersion = pluginMeta.version || '?';
const pluginAuthor = pluginMeta.author?.name || '';

// Bundle all data for panels
const d = { ...claudeData, vaultStats, beadsStats, brayneeHealth, hooksLive, ts, pluginVersion, pluginAuthor };

// One template, two sources: the interactive local dashboard and a fully
// self-contained, offline-portable artifact (no external fonts, no live-reload)
// that can be shared or dropped into a Claude artifact canvas. `artifact` toggles
// the portability tweaks; the panels + data layer are identical.
function buildHtml({ artifact = false } = {}) {
  // Artifact mode drops the Google Fonts <link> so the file is fully offline —
  // the CSS font stacks fall back to the system monospace/sans gracefully.
  const fontLinks = artifact ? '' : `<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=Syne:wght@700;800&display=swap" rel="stylesheet">`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Braynee</title>
${fontLinks}
${renderCSS()}
</head>
<body>

${renderTopbar(claudeData.acct, ts)}

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
  ${renderBeadsPanel(beadsStats)}
</main>
</div>

${renderBeadsDrawer()}

<div class="footer">GENERATED ${esc(ts.toUpperCase())} &nbsp;·&nbsp; ${esc(claudeData.acct.organizationName || '')} &nbsp;·&nbsp; BRAYNEE v${esc(pluginVersion)}${pluginAuthor ? ' · ' + esc(pluginAuthor) : ''}${artifact ? ' · PORTABLE ARTIFACT' : ''}</div>

${renderBeadsJS(beadsStats)}
${renderNavJS({ artifact })}
</body>
</html>`;
}

const html = buildHtml();
writeFileSync(outPath, html, 'utf8');
console.log('Generated: ' + outPath);

// Second source: the self-contained portable artifact (always emitted, fresh
// off the same data). Shareable, offline, droppable into an artifact canvas.
const artifactPath = join(outDir, 'braynee-dashboard.html');
writeFileSync(artifactPath, buildHtml({ artifact: true }), 'utf8');
console.log('Generated artifact: ' + artifactPath);

// cp-sjc: opening is the default for an explicit/manual run (the /health skill,
// SKILL.md, the global Brain Check command) — but the SessionStart hook must
// NOT pop Obsidian + the dashboard window on every ~4h session start. The hook
// passes `--no-open` (BRAYNEE_DASHBOARD_NO_OPEN=1 also works) so it regenerates
// the data silently. windowsHide on the open spawns so it never flashes a
// console even when it does open.
const suppressOpen = process.argv.includes('--no-open')
  || process.env.BRAYNEE_DASHBOARD_NO_OPEN === '1';

// Only open viewer if not suppressed and not opened recently (4h TTL).
const flagPath = join(home, '.claude', 'temp', 'settings-viewer-open.flag');
let shouldOpen = !suppressOpen;
try {
  const flagAge = (Date.now() - statSync(flagPath).mtimeMs) / 1000 / 60 / 60;
  if (flagAge < 4) shouldOpen = false;
} catch {}

if (shouldOpen) {
  try { writeFileSync(flagPath, new Date().toISOString()); } catch {}
  const fileUrl = 'file:///' + outPath.replace(/\\/g, '/');
  try { execSync(`obsidian web url="${fileUrl}"`, { stdio: 'ignore', windowsHide: true }); } catch {
    try { execSync(`start "" "${outPath}"`, { stdio: 'ignore', windowsHide: true }); } catch {}
  }
}
