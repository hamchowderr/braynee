import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

function encodePath(p) {
  return p.replace(/:/g, '--').replace(/[/\\]/g, '-').replace(/ /g, '-');
}

function decodeDirName(enc) {
  return enc.replace('--', ':/').replace(/-/g, '/');
}

function parseSkillMd(md) {
  let nameMatch = md.match(/^name:\s*(.+)$/m);
  if (!nameMatch) nameMatch = md.match(/^##\s*name:\s*(\S+)/m);

  let desc = '';
  const multilineDesc = md.match(/^description:\s*([>|]?)\s*\n([\s\S]*?)\n---/m);
  if (multilineDesc) {
    desc = multilineDesc[2].replace(/^\s+/gm, '').replace(/\n+/g, ' ').trim();
  } else {
    const inlineDesc = md.match(/^description:\s*["']?([^"'\n]+)["']?$/m);
    if (inlineDesc) {
      desc = inlineDesc[1].trim();
    } else {
      const malformed = md.match(/^##\s*name:\s*\S+\s+description:\s*["']?([^"'\n]+)["']?/m);
      if (malformed) desc = malformed[1].trim();
    }
  }
  return { name: nameMatch?.[1]?.trim(), desc };
}

export async function loadClaudeData() {
  const home = homedir();
  const { readdirSync: rd, statSync: st } = await import('fs');

  let s = {}, c = {}, claudeMd = '', insights = null;
  let installedSkills = [], localPlugins = [];
  let mcpJson = {}, installedPlugins = {}, customAgents = [];

  try { s = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')); } catch {}
  try { c = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')); } catch {}
  try { claudeMd = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'); } catch {}
  try { insights = JSON.parse(readFileSync(join(home, '.claude', 'usage-data', 'insightful-data.json'), 'utf8')); } catch {}
  if (!insights) {
    try { insights = JSON.parse(readFileSync(join(home, '.claude', 'usage-data', 'insightful-summary.json'), 'utf8')); } catch {}
  }
  try { mcpJson = JSON.parse(readFileSync(join(home, '.claude', '.mcp.json'), 'utf8')).mcpServers || {}; } catch {}
  try { installedPlugins = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {}; } catch {}

  // Read custom agents
  try {
    for (const f of rd(join(home, '.claude', 'agents'))) {
      if (!f.endsWith('.md')) continue;
      try {
        const md = readFileSync(join(home, '.claude', 'agents', f), 'utf8');
        const nameMatch = md.match(/^name:\s*(.+)$/m);
        const descMatch = md.match(/^description:\s*(.+)$/m);
        customAgents.push({
          file: f,
          name: nameMatch?.[1]?.trim() || f.replace('.md', ''),
          desc: descMatch?.[1]?.trim() || '',
        });
      } catch {}
    }
  } catch {}

  // Read path-scoped rules (~/.claude/rules/*.md) — frontmatter `paths:` glob list + markdown body
  let rules = [];
  try {
    for (const f of rd(join(home, '.claude', 'rules')).sort()) {
      if (!f.endsWith('.md')) continue;
      try {
        const md = readFileSync(join(home, '.claude', 'rules', f), 'utf8');
        const fm = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        let paths = [], body = md;
        if (fm) {
          body = fm[2];
          const pathsBlock = fm[1].match(/paths:\s*\n([\s\S]*?)(?=\n\S|$)/);
          if (pathsBlock) {
            paths = pathsBlock[1]
              .split('\n')
              .map(l => l.match(/-\s*["']?([^"'\n]+?)["']?\s*$/)?.[1])
              .filter(Boolean);
          }
        }
        rules.push({ file: f, paths, body: body.trim() });
      } catch {}
    }
  } catch {}

  // Read local plugins
  try {
    for (const e of rd(join(home, '.claude', 'plugins', 'local'), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try {
        let info = { id: e.name, name: e.name, desc: '', commands: [] };
        const pluginJsonPath = join(home, '.claude', 'plugins', 'local', e.name, 'plugin.json');
        const readmePath = join(home, '.claude', 'plugins', 'local', e.name, 'README.md');
        try {
          const pj = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
          info.name = pj.name || e.name;
          info.desc = pj.description || '';
        } catch {
          try {
            const readme = readFileSync(readmePath, 'utf8');
            const titleMatch = readme.match(/^#\s+(.+)$/m);
            const descMatch = readme.match(/^#[^\n]+\n+([^#\n][^\n]+)/);
            if (titleMatch) info.name = titleMatch[1].trim();
            if (descMatch) info.desc = descMatch[1].trim();
          } catch {}
        }
        localPlugins.push(info);
      } catch {}
    }
  } catch {}

  // Read project dirs
  let projectDirs = [];
  try {
    const pdRoot = join(home, '.claude', 'projects');
    for (const d of rd(pdRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dPath = join(pdRoot, d.name);
      let sessionCount = 0, sizeBytes = 0;
      try {
        for (const f of rd(dPath)) {
          if (!f.endsWith('.jsonl')) continue;
          sessionCount++;
          try { sizeBytes += st(join(dPath, f)).size; } catch {}
        }
      } catch {}
      projectDirs.push({ encoded: d.name, sessionCount, sizeBytes });
    }
  } catch {}

  // Build lookups
  const dotClaudeByEncoded = {};
  for (const [p, x] of Object.entries(c.projects || {})) {
    dotClaudeByEncoded[encodePath(p)] = { path: p, lastCost: x.lastCost || 0 };
  }

  const ig = insights?.global ?? insights ?? {};
  const insightByName = {};
  for (const [nm, x] of Object.entries(insights?.projects || {})) {
    insightByName[nm.toLowerCase()] = { hours: x.total_hours || 0, sessions: x.session_count || 0 };
  }

  const allProjects = projectDirs.map(pd => {
    const dotClaudeEntry = dotClaudeByEncoded[pd.encoded] || null;
    const decodedPath = dotClaudeEntry?.path || decodeDirName(pd.encoded);
    const displayName = decodedPath.split(/[/\\]/).filter(Boolean).pop() || pd.encoded;
    const insightKey = Object.keys(insightByName).find(k =>
      k === displayName.toLowerCase() ||
      k === pd.encoded.split('-').slice(-1)[0].toLowerCase()
    );
    const insight = insightKey ? insightByName[insightKey] : null;
    return {
      encoded: pd.encoded,
      path: decodedPath,
      name: displayName,
      sessionCount: pd.sessionCount,
      sizeBytes: pd.sizeBytes,
      lastCost: dotClaudeEntry?.lastCost || 0,
      hours: insight?.hours || 0,
      insightSessions: insight?.sessions || 0,
    };
  });

  const totalJSONLSessions = projectDirs.reduce((sum, pd) => sum + pd.sessionCount, 0);

  // Read local skills
  try {
    const skillsDir = join(home, '.claude', 'skills');
    for (const entry of rd(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const md = readFileSync(join(skillsDir, entry.name, 'SKILL.md'), 'utf8');
        const { name, desc } = parseSkillMd(md);
        installedSkills.push({ id: entry.name, name: name || entry.name, desc: desc || '', source: 'local' });
      } catch {}
    }
  } catch {}

  // Read plugin skills
  for (const [pluginId, installs] of Object.entries(installedPlugins)) {
    if (!Array.isArray(installs) || !installs.length) continue;
    const installPath = installs[0]?.installPath;
    if (!installPath) continue;
    const pluginShortName = pluginId.split('@')[0];
    try {
      const skillsDir = join(installPath, 'skills');
      for (const entry of rd(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          const md = readFileSync(join(skillsDir, entry.name, 'SKILL.md'), 'utf8');
          const { name, desc } = parseSkillMd(md);
          installedSkills.push({ id: entry.name, name: name || entry.name, desc: desc || '', source: pluginShortName, pluginId });
        } catch {}
      }
    } catch {}
  }

  // Destructure settings
  const { permissions: permissions = {}, hooks = {}, env = {}, enabledPlugins = {}, statusLine, mcpServers: sMcp = {}, voice: voiceObj, ...gen } = s;
  const voice = voiceObj || {};
  const { oauthAccount: acct = {}, mcpServers: uMcp = {}, projects, skillUsage = {}, ...prefs } = c;

  // Strip ephemeral prefs
  ['cachedGrowthBookFeatures','tipsHistory','groveConfigCache','s1mAccessCache','passesEligibilityCache',
   'githubRepoPaths','clientDataCache','feedbackSurveyState','anonymousId','userID','changelogLastFetched'
  ].forEach(k => delete prefs[k]);

  // Computed stats
  const _ig = insights?.global ?? insights ?? {};
  const appLaunches = c.numStartups || 0;
  const conversations = totalJSONLSessions;
  const _acct = _ig.message_accounting ?? _ig.accounting ?? {};
  const promptsSubmitted = _acct.total_user_prompts || '—';
  const _rawHours = _ig.total_hours ?? _ig.hours;
  const totalHours = _rawHours != null ? Number(_rawHours).toFixed(0) : '—';
  const totalProjects = allProjects.length;
  const localSkillCount = installedSkills.filter(sk => sk.source === 'local').length;
  const pluginSkillSourceCount = new Set(installedSkills.filter(sk => sk.source !== 'local').map(sk => sk.source)).size;

  return {
    s, c, claudeMd, insights, ig: _ig,
    installedSkills, localPlugins, mcpJson, installedPlugins,
    customAgents, rules, allProjects, totalJSONLSessions,
    permissions, hooks, env, enabledPlugins, statusLine,
    voice, sMcp, uMcp, gen,
    acct, prefs, projects, skillUsage,
    appLaunches, conversations, promptsSubmitted, totalHours,
    totalProjects, localSkillCount, pluginSkillSourceCount,
    _acct,
  };
}
