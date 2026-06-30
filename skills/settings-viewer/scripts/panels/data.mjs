import { esc, installedSkillsGrid, localPluginsPanel, kvTable } from '../html/utils.mjs';
import { chartBox, barChartHeight, renderBarChartJS } from '../html/charts.mjs';

export function renderProjectsPanel(d) {
  const { allProjects } = d;
  const n = Math.min(25, allProjects.length);
  return `<div id="panel-projects" class="panel">
    <div class="section-head">
      <div class="section-title">Projects</div>
      <div class="section-tag">${allProjects.length} total · top ${n} by conversation size · source: ~/.claude/projects/</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>Conversation Size (MB)</div>
      <div class="card-body">${allProjects.length ? chartBox('projects-chart', barChartHeight(n)) : `<p class="nil">— no data —</p>`}</div>
    </div>
  </div>`;
}

export function renderProjectsJS(d) {
  const { allProjects } = d;
  const sizes = {};
  for (const p of allProjects) sizes[p.name] = Math.round((p.sizeBytes / 1048576) * 10) / 10;
  return renderBarChartJS('projects', 'projects-chart', sizes, { color: '#f5a623', horizontal: true, limit: 25, suffix: 'MB' });
}

export function renderSkillUsagePanel(d) {
  const { skillUsage } = d;
  const n = Math.min(20, Object.keys(skillUsage || {}).length);
  return `<div id="panel-skills" class="panel">
    <div class="section-head">
      <div class="section-title">Skill Usage</div>
      <div class="section-tag">invocation frequency from .claude.json · top ${n}</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot" style="background:var(--blue)"></div>Top Skills by Use Count</div>
      <div class="card-body">${Object.keys(skillUsage || {}).length ? chartBox('skills-chart', barChartHeight(n)) : `<p class="nil">— no usage data —</p>`}</div>
    </div>
  </div>`;
}

export function renderSkillUsageJS(d) {
  const { skillUsage } = d;
  const counts = {};
  for (const [name, x] of Object.entries(skillUsage || {})) counts[name] = x.usageCount || 0;
  return renderBarChartJS('skills', 'skills-chart', counts, { color: '#5bc0f8', horizontal: true, limit: 20 });
}

export function renderInstalledSkillsPanel(d) {
  const { installedSkills, localSkillCount, pluginSkillSourceCount } = d;
  return `<div id="panel-iskills" class="panel">
    <div class="section-head">
      <div class="section-title">Installed Skills</div>
      <div class="section-tag">${installedSkills.length} skills · ${localSkillCount} local · ${pluginSkillSourceCount} plugins</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>All Skills</div>
      <div class="card-body">${installedSkillsGrid(installedSkills)}</div>
    </div>
  </div>`;
}

export function renderLocalPluginsPanel(d) {
  const { localPlugins } = d;
  return `<div id="panel-lplugins" class="panel">
    <div class="section-head">
      <div class="section-title">Local Plugins</div>
      <div class="section-tag">${localPlugins.length} plugins · ~/.claude/plugins/</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>Installed Local Plugins</div>
      <div class="card-body">${localPluginsPanel(localPlugins)}</div>
    </div>
  </div>`;
}

export function renderPrefsPanel(d) {
  const { prefs } = d;
  return `<div id="panel-prefs" class="panel">
    <div class="section-head">
      <div class="section-title">Preferences</div>
      <div class="section-tag">.claude.json runtime state</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>User Preferences</div>
      <div class="card-body">${kvTable(prefs)}</div>
    </div>
  </div>`;
}
