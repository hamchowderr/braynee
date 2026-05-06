import { esc, projectRows, skillBars, installedSkillsGrid, localPluginsPanel, kvTable } from '../html/utils.mjs';

export function renderProjectsPanel(d) {
  const { allProjects } = d;
  return `<div id="panel-projects" class="panel">
    <div class="section-head">
      <div class="section-title">Projects</div>
      <div class="section-tag">${allProjects.length} total · source: ~/.claude/projects/</div>
    </div>
    <div class="card" style="margin-bottom:14px;border-color:rgba(245,166,35,.2);background:rgba(245,166,35,.03)">
      <div class="card-body" style="font-size:11px;color:var(--ink-2);padding:10px 16px;">
        <strong style="color:var(--amber)">Ground truth:</strong> ~/.claude/projects/ (${allProjects.length} dirs) · bars = conversation size · columns: MB · sessions · last cost
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>All Projects</div>
      <div class="card-body">${projectRows(allProjects)}</div>
    </div>
  </div>`;
}

export function renderSkillUsagePanel(d) {
  const { skillUsage } = d;
  return `<div id="panel-skills" class="panel">
    <div class="section-head">
      <div class="section-title">Skill Usage</div>
      <div class="section-tag">invocation frequency from .claude.json</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>Top 20 by Use Count</div>
      <div class="card-body">${skillBars(skillUsage)}</div>
    </div>
  </div>`;
}

export function renderInstalledSkillsPanel(d) {
  const { installedSkills, skillUsage, localSkillCount, pluginSkillSourceCount } = d;
  return `<div id="panel-iskills" class="panel">
    <div class="section-head">
      <div class="section-title">Installed Skills</div>
      <div class="section-tag">${installedSkills.length} skills · ${localSkillCount} local · ${pluginSkillSourceCount} plugins</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>All Skills</div>
      <div class="card-body">${installedSkillsGrid(installedSkills, skillUsage)}</div>
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
