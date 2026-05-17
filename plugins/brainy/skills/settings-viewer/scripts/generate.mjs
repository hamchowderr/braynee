import { writeFileSync, mkdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

import { loadClaudeData } from './data/claude.mjs';
import { loadVaultStats } from './data/vault.mjs';
import { loadBeadsStats } from './data/beads.mjs';
import { computeAllHookCmds, computeBrainyHealth, computeHooksLive } from './data/brainy.mjs';

import { renderCSS, renderTopbar, renderSidebar, renderNavJS } from './html/shell.mjs';
import { esc } from './html/utils.mjs';

import { renderGeneralPanel, renderPermissionsPanel, renderHooksPanel, renderPluginsPanel, renderMcpPanel, renderAgentsPanel, renderClaudeMdPanel } from './panels/config.mjs';
import { renderProjectsPanel, renderSkillUsagePanel, renderInstalledSkillsPanel, renderLocalPluginsPanel, renderPrefsPanel } from './panels/data.mjs';
import { renderAnalyticsPanel, renderToolUsagePanel, renderProjectHoursPanel } from './panels/insights.mjs';
import { renderBrainyPanel } from './panels/brainy.mjs';
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
const brainyHealth = computeBrainyHealth(claudeData.s, allHookCmds);
const hooksLive = computeHooksLive();
const ts = new Date().toLocaleString();

// Bundle all data for panels
const d = { ...claudeData, vaultStats, beadsStats, brainyHealth, hooksLive, ts };

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brainy</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=Syne:wght@700;800&display=swap" rel="stylesheet">
${renderCSS()}
</head>
<body>

${renderTopbar(claudeData.acct, ts)}

<div class="layout">
${renderSidebar()}

<main class="main">
  ${renderBrainyPanel(d)}
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
  ${renderClaudeMdPanel(d)}
  ${renderAnalyticsPanel(d)}
  ${renderToolUsagePanel(d)}
  ${renderProjectHoursPanel(d)}
  ${renderBeadsPanel(beadsStats)}
</main>
</div>

${renderBeadsDrawer()}

<div class="footer">GENERATED ${esc(ts.toUpperCase())} &nbsp;·&nbsp; ${esc(claudeData.acct.organizationName || '')} &nbsp;·&nbsp; BRAINY v1.2.0 · Otaku Solutions</div>

${renderBeadsJS(beadsStats)}
${renderNavJS()}
</body>
</html>`;

writeFileSync(outPath, html, 'utf8');
console.log('Generated: ' + outPath);

// Only open viewer if not opened recently (4h TTL)
const flagPath = join(home, '.claude', 'temp', 'settings-viewer-open.flag');
let shouldOpen = true;
try {
  const flagAge = (Date.now() - statSync(flagPath).mtimeMs) / 1000 / 60 / 60;
  if (flagAge < 4) shouldOpen = false;
} catch {}

if (shouldOpen) {
  try { writeFileSync(flagPath, new Date().toISOString()); } catch {}
  const fileUrl = 'file:///' + outPath.replace(/\\/g, '/');
  try { execSync(`obsidian web url="${fileUrl}"`, { shell: true }); } catch {
    try { execSync(`start "" "${outPath}"`, { shell: true }); } catch {}
  }
}
