import { esc } from './utils.mjs';

export function renderCSS() {
  return `<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --ink:    #f0ede8;
  --ink-2:  #9e9890;
  --ink-3:  #5a5650;
  --bg:     #090b0e;
  --bg-2:   #0f1215;
  --bg-3:   #161a1f;
  --bg-4:   #1d2228;
  --line:   #252b32;
  --line-2: #2e3540;
  --amber:  #f5a623;
  --amber-d:#c47a08;
  --green:  #3ddc84;
  --red:    #ff5c5c;
  --blue:   #5bc0f8;
  --yellow: #f5d76e;
  --purple: #b48eff;
  --mo: 'IBM Plex Mono', monospace;
  --di: 'Syne', sans-serif;
}

html, body { height: 100%; }

body {
  background: var(--bg);
  color: var(--ink);
  font-family: var(--mo);
  font-size: 13px;
  line-height: 1.7;
  display: flex;
  flex-direction: column;
  background-image: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(255,255,255,.012) 2px,
    rgba(255,255,255,.012) 4px
  );
  background-attachment: fixed;
}

/* ── TOPBAR ─────────────────────────────────────────────── */
.topbar {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 0 28px;
  height: 52px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-2);
  flex-shrink: 0;
  position: sticky;
  top: 0;
  z-index: 100;
}
.topbar-logo { font-family: var(--di); font-size: 15px; font-weight: 800; letter-spacing: .12em; color: var(--amber); text-transform: uppercase; }
.topbar-sep { color: var(--line-2); }
.topbar-sub { font-size: 11px; color: var(--ink-3); letter-spacing: .08em; text-transform: uppercase; }
.topbar-account { margin-left: auto; display: flex; align-items: center; gap: 16px; font-size: 11px; color: var(--ink-2); }
.acct-email { color: var(--amber); font-weight: 500; }
.acct-badge { background: var(--bg-4); border: 1px solid var(--line-2); padding: 2px 8px; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); }

/* ── LAYOUT ─────────────────────────────────────────────── */
.layout { display: flex; flex: 1; min-height: 0; }

/* ── SIDEBAR ────────────────────────────────────────────── */
.sidebar { width: 200px; flex-shrink: 0; border-right: 1px solid var(--line); background: var(--bg-2); padding: 20px 0; overflow-y: auto; }
.sidebar-section { font-size: 9px; letter-spacing: .15em; text-transform: uppercase; color: var(--ink-3); padding: 0 20px 8px; margin-top: 8px; }
.nav-item { display: flex; align-items: center; gap: 10px; padding: 8px 20px; cursor: pointer; font-size: 12px; color: var(--ink-2); border-left: 2px solid transparent; transition: all .12s; letter-spacing: .02em; }
.nav-item:hover { color: var(--ink); background: var(--bg-3); }
.nav-item.active { color: var(--amber); border-left-color: var(--amber); background: rgba(245,166,35,.07); font-weight: 500; }
.nav-icon { font-size: 13px; width: 16px; text-align: center; flex-shrink: 0; }

/* ── MAIN ───────────────────────────────────────────────── */
.main { flex: 1; overflow-y: auto; padding: 36px 44px; }
.panel { display: none; animation: fadeIn .18s ease; }
.panel.active { display: block; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

/* ── SECTION HEADERS ────────────────────────────────────── */
.section-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 28px; }
.section-title { font-family: var(--di); font-size: 20px; font-weight: 800; color: var(--ink); letter-spacing: -.01em; }
.section-tag { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); }

/* ── STAT ROW ───────────────────────────────────────────── */
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 32px; }
.stat-box { background: var(--bg-3); border: 1px solid var(--line); padding: 22px 22px; position: relative; overflow: hidden; }
.stat-box::before { content: ''; position: absolute; top: 0; left: 0; width: 3px; height: 100%; background: var(--amber); }
.stat-num { font-family: var(--di); font-size: 32px; font-weight: 800; color: var(--amber); line-height: 1; }
.stat-lbl { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); margin-top: 8px; }

/* ── CARDS ──────────────────────────────────────────────── */
.card { background: var(--bg-3); border: 1px solid var(--line); margin-bottom: 20px; }
.card-head { padding: 13px 20px; border-bottom: 1px solid var(--line); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); background: var(--bg-4); display: flex; align-items: center; gap: 8px; }
.card-head-dot { width: 5px; height: 5px; background: var(--amber); flex-shrink: 0; }
.card-body { padding: 20px; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }

/* ── KV TABLE ───────────────────────────────────────────── */
.kv { width: 100%; border-collapse: collapse; }
.kv tr { border-bottom: 1px solid var(--line); }
.kv tr:last-child { border-bottom: none; }
.kv td { padding: 10px 0; vertical-align: top; }
.prop { color: var(--blue); font-size: 11px; white-space: nowrap; width: 1px; padding-right: 20px; letter-spacing: .02em; }
.scalar { color: var(--ink); }
.json-val { font-size: 10px; color: var(--ink-3); white-space: pre-wrap; word-break: break-all; }

/* ── CHIPS ──────────────────────────────────────────────── */
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-size: 10px; padding: 3px 8px; letter-spacing: .04em; font-family: var(--mo); }
.chip-on  { background: rgba(61,220,132,.12); color: var(--green);  border: 1px solid rgba(61,220,132,.25); }
.chip-off { background: rgba(255,92,92,.1);   color: var(--red);    border: 1px solid rgba(255,92,92,.2);  }
.chip-val { background: var(--bg-4);           color: var(--blue);   border: 1px solid var(--line-2);       }
.chip-allow  { background: rgba(61,220,132,.08); color: var(--green);  border: 1px solid rgba(61,220,132,.2); }
.chip-deny   { background: rgba(255,92,92,.08);  color: var(--red);    border: 1px solid rgba(255,92,92,.18); }
.chip-ask    { background: rgba(245,215,110,.08); color: var(--yellow); border: 1px solid rgba(245,215,110,.2); }

/* ── HOOKS ──────────────────────────────────────────────── */
.hook-block { margin-bottom: 20px; }
.hook-block:last-child { margin-bottom: 0; }
.hook-ev-label { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--purple); margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
.hook-row { display: flex; align-items: flex-start; gap: 12px; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,.05); }
.hook-mat { flex-shrink: 0; font-size: 10px; color: var(--yellow); background: rgba(245,215,110,.08); border: 1px solid rgba(245,215,110,.2); padding: 2px 7px; min-width: 52px; text-align: center; letter-spacing: .04em; }
.hook-cmd { font-size: 11px; color: var(--ink-2); word-break: break-all; line-height: 1.5; }

/* ── PLUGINS ────────────────────────────────────────────── */
.plugin-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
.plugin-tile { background: var(--bg-4); border: 1px solid var(--line-2); padding: 12px 14px; display: flex; flex-direction: column; gap: 3px; transition: border-color .15s; }
.plugin-tile:hover { border-color: var(--amber); }
.plugin-off { opacity: .35; }
.plugin-dot { width: 6px; height: 6px; border-radius: 50%; margin-bottom: 6px; }
.dot-on  { background: var(--green); box-shadow: 0 0 6px var(--green); }
.dot-off { background: var(--ink-3); }
.plugin-nm  { font-size: 12px; font-weight: 500; color: var(--ink); }
.plugin-mkt { font-size: 10px; color: var(--ink-3); }

/* ── PROJECTS ───────────────────────────────────────────── */
.proj-list { display: flex; flex-direction: column; gap: 0; }
.proj-row { display: grid; grid-template-columns: 28px 1fr 140px 64px; align-items: center; gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--line); }
.proj-row:last-child { border-bottom: none; }
.proj-rank { font-size: 10px; color: var(--ink-3); letter-spacing: .05em; }
.proj-nm { font-size: 12px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proj-bar-wrap { width: 100%; height: 3px; background: var(--line); min-width: 0; }
.proj-bar { height: 100%; background: var(--amber); transition: width .3s ease; }
.proj-cost { font-size: 12px; color: var(--green); font-weight: 500; text-align: right; min-width: 52px; }

/* ── MCP ────────────────────────────────────────────────── */
.mcp-cards { display: flex; flex-direction: column; gap: 8px; }
.mcp-card { background: var(--bg-4); border: 1px solid var(--line-2); border-left: 3px solid var(--amber); padding: 10px 14px; }
.mcp-name { font-size: 13px; color: var(--amber); font-weight: 500; margin-bottom: 2px; }
.mcp-type { font-size: 10px; color: var(--ink-3); letter-spacing: .06em; text-transform: uppercase; margin-bottom: 5px; }
.mcp-cmd  { font-size: 10px; color: var(--ink-2); word-break: break-all; }

/* ── SKILLS ─────────────────────────────────────────────── */
.skill-list { display: flex; flex-direction: column; gap: 0; }
.skill-row { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--line); }
.skill-row:last-child { border-bottom: none; }
.skill-nm { font-size: 11px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skill-bar-wrap { width: 100px; height: 3px; background: var(--line); }
.skill-bar { height: 100%; background: var(--blue); }
.skill-ct { font-size: 11px; color: var(--blue); min-width: 28px; text-align: right; }

/* ── MISC ───────────────────────────────────────────────── */
.nil { font-size: 11px; color: var(--ink-3); letter-spacing: .05em; font-style: italic; padding: 8px 0; }

/* ── INSTALLED SKILLS ──────────────────────────────────── */
.iskill-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
.iskill-card { background: var(--bg-4); border: 1px solid var(--line-2); border-left: 3px solid var(--blue); padding: 12px 14px; display: flex; flex-direction: column; gap: 5px; transition: border-color .15s; }
.iskill-card:hover { border-color: var(--amber); }
.iskill-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.iskill-name { font-size: 13px; font-weight: 500; color: var(--ink); }
.iskill-uses { font-size: 10px; color: var(--amber); background: rgba(245,166,35,.1); border: 1px solid rgba(245,166,35,.2); padding: 1px 6px; white-space: nowrap; }
.iskill-id { font-size: 10px; color: var(--blue); letter-spacing: .04em; }
.iskill-desc { font-size: 11px; color: var(--ink-2); line-height: 1.5; }
.iskill-group { margin-bottom: 24px; }
.iskill-group:last-child { margin-bottom: 0; }
.iskill-group-head { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); padding-bottom: 8px; margin-bottom: 10px; border-bottom: 1px solid var(--line); }

/* ── LOCAL PLUGINS ──────────────────────────────────────── */
.lplugin-card { background: var(--bg-4); border: 1px solid var(--line-2); border-left: 3px solid var(--purple); padding: 14px 16px; margin-bottom: 10px; }
.lplugin-card:last-child { margin-bottom: 0; }
.lplugin-header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
.lplugin-name { font-size: 14px; font-weight: 600; color: var(--ink); }
.lplugin-id { font-size: 10px; color: var(--purple); letter-spacing: .06em; }
.lplugin-desc { font-size: 12px; color: var(--ink-2); margin-bottom: 10px; line-height: 1.5; }
.lplugin-cmds { display: flex; flex-wrap: wrap; gap: 6px; }

/* ── HOOK COVERAGE ──────────────────────────────────────── */
.hcov-summary { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
.hcov-bar-wrap { flex: 1; height: 4px; background: var(--line); }
.hcov-bar { height: 100%; background: linear-gradient(90deg, var(--green), var(--amber)); transition: width .4s ease; }
.hcov-label { font-size: 11px; color: var(--green); white-space: nowrap; letter-spacing: .04em; }
.hcev-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 6px; margin-bottom: 14px; }
.hcev-tile { display: flex; align-items: center; gap: 7px; padding: 7px 10px; border: 1px solid var(--line-2); background: var(--bg-4); font-size: 11px; letter-spacing: .02em; cursor: default; }
.hcev-on  { border-color: rgba(61,220,132,.2); background: rgba(61,220,132,.04); }
.hcev-off { opacity: .4; }
.hcev-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
.hcev-ct { font-size: 10px; color: var(--green); background: rgba(61,220,132,.1); border: 1px solid rgba(61,220,132,.2); padding: 1px 5px; min-width: 18px; text-align: center; }

/* ── VOICE ──────────────────────────────────────────────── */
.voice-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.voice-item { background: var(--bg-4); border: 1px solid var(--line-2); padding: 12px 14px; }
.voice-lbl { font-size: 9px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 6px; }
.voice-val { display: flex; }

.md-source { font-family: var(--mo); font-size: 12px; line-height: 1.7; color: var(--ink); white-space: pre-wrap; word-break: break-word; tab-size: 2; }

.footer { padding: 8px 32px; font-size: 10px; color: var(--ink-3); border-top: 1px solid var(--line); background: var(--bg-2); letter-spacing: .06em; flex-shrink: 0; }

/* ── AGENTS ─────────────────────────────────────────────── */
.agent-list { display: flex; flex-direction: column; gap: 8px; }
.agent-card { background: var(--bg-4); border: 1px solid var(--line-2); border-left: 3px solid var(--green); padding: 12px 16px; }
.agent-name { font-size: 13px; font-weight: 500; color: var(--green); margin-bottom: 2px; }
.agent-file { font-size: 10px; color: var(--ink-3); letter-spacing: .04em; margin-bottom: 5px; }
.agent-desc { font-size: 12px; color: var(--ink-2); line-height: 1.5; }

/* ── MCP ENV ────────────────────────────────────────────── */
.mcp-env { margin-top: 6px; font-size: 10px; display: flex; flex-wrap: wrap; gap: 8px; }
.mcp-env-key { color: var(--yellow); }
.mcp-env-val { color: var(--red); }

/* ── BEADS DASHBOARD ────────────────────────────────────── */
.beads-layout { display: flex; gap: 0; min-height: 480px; border: 1px solid var(--line); background: var(--bg-3); }
.beads-proj-sidebar { width: 180px; flex-shrink: 0; border-right: 1px solid var(--line); overflow-y: auto; padding: 8px 0; }
.beads-proj-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 14px; cursor: pointer; font-size: 11px; color: var(--ink-3); border-left: 2px solid transparent; transition: all .1s; }
.beads-proj-item:hover { color: var(--ink-2); background: var(--bg-4); }
.beads-proj-item.active { color: var(--amber); border-left-color: var(--amber); background: rgba(245,166,35,.07); }
.bd-proj-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.bd-badge { font-size: 9px; padding: 1px 5px; border-radius: 2px; flex-shrink: 0; }
.bd-badge-open   { background: rgba(245,166,35,.15); color: var(--amber); }
.bd-badge-closed { background: rgba(61,220,132,.1);  color: var(--green); }
.bd-badge-zero   { background: var(--bg-4); color: var(--ink-3); }
.beads-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.beads-filters { display: flex; align-items: center; gap: 6px; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--bg-4); }
.bf { background: var(--bg-3); border: 1px solid var(--line-2); color: var(--ink-3); font-family: var(--mo); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; padding: 3px 10px; cursor: pointer; transition: all .1s; }
.bf:hover { color: var(--ink-2); border-color: var(--amber); }
.bf.bf-active { background: rgba(245,166,35,.1); border-color: var(--amber); color: var(--amber); }
.bt-head { display: flex; align-items: center; padding: 7px 16px; border-bottom: 1px solid var(--line); background: var(--bg-4); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
.bt-row { display: flex; align-items: center; padding: 9px 16px; border-bottom: 1px solid var(--line); font-size: 11px; transition: background .08s; cursor: pointer; }
.bt-row:last-child { border-bottom: none; }
.bt-row:hover { background: var(--bg-4); }
.bt-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
.bd-id { font-family: var(--mo); font-size: 10px; color: var(--ink-3); }
#bd-rows { overflow-y: auto; max-height: 520px; }

/* ── BEADS DRAWER ───────────────────────────────────────── */
.bd-drawer-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 200; }
.bd-drawer-overlay.open { display: block; }
.bd-drawer { position: fixed; top: 0; right: 0; width: 480px; height: 100vh; background: var(--bg-2); border-left: 1px solid var(--line-2); z-index: 201; display: flex; flex-direction: column; transform: translateX(100%); transition: transform .18s cubic-bezier(.4,0,.2,1); overflow: hidden; }
.bd-drawer-overlay.open .bd-drawer { transform: translateX(0); }
.bd-drawer-head { padding: 16px 20px 14px; border-bottom: 1px solid var(--line); background: var(--bg-3); display: flex; align-items: flex-start; gap: 12px; flex-shrink: 0; }
.bd-drawer-title { flex: 1; font-size: 13px; font-weight: 500; color: var(--ink); line-height: 1.4; }
.bd-drawer-close { background: none; border: 1px solid var(--line-2); color: var(--ink-3); font-family: var(--mo); font-size: 13px; cursor: pointer; padding: 2px 8px; flex-shrink: 0; transition: all .1s; }
.bd-drawer-close:hover { color: var(--ink); border-color: var(--amber); }
.bd-drawer-meta { padding: 12px 20px; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 6px; flex-shrink: 0; background: var(--bg-3); }
.bd-meta-chip { font-size: 10px; letter-spacing: .06em; padding: 3px 8px; border: 1px solid var(--line-2); background: var(--bg-4); color: var(--ink-3); }
.bd-drawer-body { flex: 1; overflow-y: auto; padding: 0; }
.bd-section { padding: 16px 20px; border-bottom: 1px solid var(--line); }
.bd-section:last-child { border-bottom: none; }
.bd-section-label { font-size: 9px; letter-spacing: .14em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 8px; }
.bd-section-text { font-size: 12px; color: var(--ink-2); line-height: 1.65; white-space: pre-wrap; word-break: break-word; }
.bd-section-nil { font-size: 11px; color: var(--ink-3); font-style: italic; }
.bd-id-label { font-family: var(--mo); font-size: 10px; color: var(--ink-3); letter-spacing: .04em; }
</style>`;
}

export function renderTopbar(acct, ts) {
  return `<div class="topbar">
  <div class="topbar-logo">Brainy</div>
  <div class="topbar-sep">/</div>
  <div class="topbar-sub">Second Brain Dashboard</div>
  <div class="topbar-account">
    <span class="acct-email">${esc(acct.emailAddress || '')}</span>
    <span class="acct-badge">${esc(acct.organizationRole || 'user')}</span>
    <span class="acct-badge">${esc(acct.billingType || '')}</span>
    ${acct.hasExtraUsageEnabled ? `<span class="acct-badge" style="color:var(--green);border-color:rgba(61,220,132,.3)">extra ✓</span>` : ''}
  </div>
</div>`;
}

export function renderSidebar() {
  return `<nav class="sidebar">
  <div class="nav-item active" onclick="nav('brainy',this)" style="padding:12px 20px;margin-bottom:4px"><span class="nav-icon">🧠</span> <strong>Brainy</strong></div>
  <div class="sidebar-section" style="margin-top:8px">Claude Code</div>
  <div class="nav-item" onclick="nav('general',this)"><span class="nav-icon">◈</span> General</div>
  <div class="nav-item" onclick="nav('permissions',this)"><span class="nav-icon">⬡</span> Permissions</div>
  <div class="nav-item" onclick="nav('hooks',this)"><span class="nav-icon">⟳</span> Hooks</div>
  <div class="nav-item" onclick="nav('plugins',this)"><span class="nav-icon">⊞</span> Plugins</div>
  <div class="nav-item" onclick="nav('mcp',this)"><span class="nav-icon">⌥</span> MCP Servers</div>
  <div class="nav-item" onclick="nav('agents',this)"><span class="nav-icon">◈</span> Agents</div>
  <div class="sidebar-section" style="margin-top:16px">Data</div>
  <div class="nav-item" onclick="nav('projects',this)"><span class="nav-icon">▤</span> Projects</div>
  <div class="nav-item" onclick="nav('skills',this)"><span class="nav-icon">◎</span> Skill Usage</div>
  <div class="nav-item" onclick="nav('iskills',this)"><span class="nav-icon">▣</span> Installed Skills</div>
  <div class="nav-item" onclick="nav('lplugins',this)"><span class="nav-icon">⊞</span> Local Plugins</div>
  <div class="nav-item" onclick="nav('prefs',this)"><span class="nav-icon">≡</span> Preferences</div>
  <div class="nav-item" onclick="nav('claudemd',this)"><span class="nav-icon">📄</span> CLAUDE.md</div>
  <div class="sidebar-section" style="margin-top:16px">Insights</div>
  <div class="nav-item" onclick="nav('analytics',this)"><span class="nav-icon">◉</span> Analytics</div>
  <div class="nav-item" onclick="nav('tools',this)"><span class="nav-icon">⌁</span> Tool Usage</div>
  <div class="nav-item" onclick="nav('iprojects',this)"><span class="nav-icon">⬙</span> Project Hours</div>
  <div class="nav-item" onclick="nav('beads',this)"><span class="nav-icon">◈</span> Beads</div>
</nav>`;
}

export function renderNavJS() {
  return `<script>
let _beadsTimer = null;

function nav(id, el) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('panel-' + id).classList.add('active');
  el.classList.add('active');
  sessionStorage.setItem('brainy-panel', id);
  if (_beadsTimer) { clearInterval(_beadsTimer); _beadsTimer = null; }
  if (id === 'beads') { _beadsTimer = setInterval(() => location.reload(), 30000); }
}

(function() {
  const saved = sessionStorage.getItem('brainy-panel') || 'brainy';
  const panel = document.getElementById('panel-' + saved);
  if (panel) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    panel.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => {
      if (n.getAttribute('onclick') === "nav('" + saved + "',this)") n.classList.add('active');
    });
    if (saved === 'beads') { _beadsTimer = setInterval(() => location.reload(), 30000); }
  }
  renderBeads();
})();
</script>`;
}
