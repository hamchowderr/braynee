import { esc } from './utils.mjs';

// Second Brain Dashboard — shell + design system.
//
// The look is a hand-written shadcn-style system (zinc neutral surfaces, amber
// accent, Inter + JetBrains Mono, light/dark) — NOT Tailwind, so it works in
// file mode, server mode, AND the offline portable artifact with no build/CDN.
//
// Every panel's markup references the CSS variables below (--bg-*, --ink-*,
// --line-*, --amber/--green/...) and the shared component classes (.card,
// .stat-box, .nav-item, .chip, .kv, ...). Re-theming = redefining the variables +
// restyling those classes here, so the whole dashboard reskins from one file.

export function renderCSS() {
  return `<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

/* ── DESIGN TOKENS (dark default; .light overrides) ──────────────────────── */
:root {
  --bg:     #0a0b0d;  --bg-2: #101113;  --bg-3: #141518;  --bg-4: #1c1d21;
  --ink:    #f4f4f5;  --ink-2:#b6b6bd;  --ink-3:#86868f;
  --line:   #26262c;  --line-2:#33333b;
  --amber:  #f5a623;  --amber-d:#c47a08;
  --green:  #34d399;  --blue: #38bdf8;  --red: #fb7185;  --purple:#a78bfa;  --yellow:#facc15;
  --shadow: 0 1px 2px rgba(0,0,0,.4);
  --r: 12px;  --r-sm: 8px;
  --sans: 'Inter', system-ui, -apple-system, sans-serif;
  --mo:   'JetBrains Mono', ui-monospace, monospace;
  --di:   'Inter', system-ui, sans-serif;
}
:root.light {
  --bg:     #ffffff;  --bg-2: #fafafa;  --bg-3: #ffffff;  --bg-4: #f4f4f5;
  --ink:    #18181b;  --ink-2:#52525b;  --ink-3:#71717a;
  --line:   #e7e7ea;  --line-2:#d8d8dd;
  --amber:  #d97706;  --amber-d:#b45309;
  --green:  #059669;  --blue: #0284c7;  --red: #e11d48;  --purple:#7c3aed;  --yellow:#ca8a04;
  --shadow: 0 1px 2px rgba(0,0,0,.06);
}

html, body { height: 100%; }
* { scrollbar-width: thin; scrollbar-color: var(--line-2) transparent; }
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 8px; }
*::-webkit-scrollbar-track { background: transparent; }

body {
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 13px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
code, .mono, .bd-id, .mcp-cmd, .hook-cmd { font-family: var(--mo); }

/* ── TOPBAR ──────────────────────────────────────────────────────────────── */
.topbar {
  display: flex; align-items: center; gap: 14px;
  padding: 0 24px; height: 56px;
  border-bottom: 1px solid var(--line); background: var(--bg);
  position: sticky; top: 0; z-index: 100; flex-shrink: 0;
}
.topbar-logo { display: flex; align-items: center; gap: 9px; font-family: var(--di); font-size: 15px; font-weight: 700; letter-spacing: -.01em; color: var(--ink); }
.topbar-logo .brain { font-size: 19px; line-height: 1; }
.topbar-sep { color: var(--line-2); }
.topbar-sub { font-size: 12px; color: var(--ink-3); font-weight: 500; }
.topbar-account { margin-left: auto; display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--ink-2); }
.acct-email { color: var(--ink-2); }
.acct-badge { background: var(--bg-4); border: 1px solid var(--line); padding: 3px 9px; border-radius: 999px; font-size: 11px; color: var(--ink-3); }
.theme-toggle { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--r-sm); border: 1px solid var(--line); background: var(--bg-3); color: var(--ink-2); cursor: pointer; font-size: 14px; transition: background .12s, border-color .12s; }
.theme-toggle:hover { background: var(--bg-4); border-color: var(--line-2); }

/* ── LAYOUT ──────────────────────────────────────────────────────────────── */
.layout { display: flex; flex: 1; min-height: 0; }

/* ── SIDEBAR ─────────────────────────────────────────────────────────────── */
.sidebar { width: 224px; flex-shrink: 0; border-right: 1px solid var(--line); background: var(--bg); padding: 14px 12px; overflow-y: auto; }
.sidebar-section { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); padding: 0 10px 6px; margin-top: 14px; font-weight: 600; }
.nav-item { display: flex; align-items: center; gap: 10px; padding: 7px 10px; margin-bottom: 2px; border-radius: var(--r-sm); cursor: pointer; font-size: 13px; color: var(--ink-2); transition: background .1s, color .1s; }
.nav-item:hover { color: var(--ink); background: var(--bg-4); }
.nav-item.active { color: var(--ink); background: var(--bg-4); font-weight: 500; }
.nav-item.active .nav-icon { filter: none; }
.nav-icon { font-size: 14px; width: 18px; text-align: center; flex-shrink: 0; opacity: .9; }

/* ── MAIN ────────────────────────────────────────────────────────────────── */
.main { flex: 1; overflow-y: auto; padding: 28px 36px; }
.panel { display: none; animation: fade .18s ease; }
.panel.active { display: block; }
@keyframes fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

/* ── SECTION HEADERS ─────────────────────────────────────────────────────── */
.section-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 22px; }
.section-title { font-family: var(--di); font-size: 22px; font-weight: 700; color: var(--ink); letter-spacing: -.02em; }
.section-tag { font-size: 12px; color: var(--ink-3); }

/* ── STATS ───────────────────────────────────────────────────────────────── */
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 26px; }
.stat-box { background: var(--bg-3); border: 1px solid var(--line); border-radius: var(--r); padding: 18px 20px; box-shadow: var(--shadow); }
.stat-num { font-family: var(--di); font-size: 30px; font-weight: 700; color: var(--ink); line-height: 1; letter-spacing: -.02em; }
.stat-lbl { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-3); margin-top: 8px; font-weight: 500; }

/* ── CARDS ───────────────────────────────────────────────────────────────── */
.card { background: var(--bg-3); border: 1px solid var(--line); border-radius: var(--r); margin-bottom: 16px; box-shadow: var(--shadow); overflow: hidden; }
.card-head { padding: 12px 18px; border-bottom: 1px solid var(--line); font-size: 12px; font-weight: 600; color: var(--ink); background: transparent; display: flex; align-items: center; gap: 9px; }
.card-head-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--amber); flex-shrink: 0; }
.card-body { padding: 18px; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }

/* ── KV TABLE ────────────────────────────────────────────────────────────── */
.kv { width: 100%; border-collapse: collapse; }
.kv tr { border-bottom: 1px solid var(--line); }
.kv tr:last-child { border-bottom: none; }
.kv td { padding: 9px 0; vertical-align: top; }
.prop { color: var(--ink-3); font-size: 12px; white-space: nowrap; width: 1px; padding-right: 20px; }
.scalar { color: var(--ink); }
.json-val { font-family: var(--mo); font-size: 11px; color: var(--ink-3); white-space: pre-wrap; word-break: break-all; }

/* ── CHIPS ───────────────────────────────────────────────────────────────── */
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-size: 11px; padding: 3px 9px; border-radius: 999px; font-family: var(--mo); border: 1px solid var(--line-2); }
.chip-on  { background: color-mix(in srgb, var(--green) 14%, transparent); color: var(--green);  border-color: color-mix(in srgb, var(--green) 30%, transparent); }
.chip-off { background: color-mix(in srgb, var(--red) 12%, transparent);   color: var(--red);    border-color: color-mix(in srgb, var(--red) 26%, transparent); }
.chip-val { background: var(--bg-4); color: var(--blue); }
.chip-allow { background: color-mix(in srgb, var(--green) 10%, transparent); color: var(--green); border-color: color-mix(in srgb, var(--green) 24%, transparent); }
.chip-deny  { background: color-mix(in srgb, var(--red) 10%, transparent);   color: var(--red);   border-color: color-mix(in srgb, var(--red) 22%, transparent); }
.chip-ask   { background: color-mix(in srgb, var(--yellow) 12%, transparent); color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 26%, transparent); }

/* ── HOOKS ───────────────────────────────────────────────────────────────── */
.hook-block { margin-bottom: 18px; }
.hook-block:last-child { margin-bottom: 0; }
.hook-ev-label { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--purple); margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--line); font-weight: 600; }
.hook-row { display: flex; align-items: flex-start; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--line); }
.hook-row:last-child { border-bottom: none; }
.hook-mat { flex-shrink: 0; font-size: 10px; color: var(--yellow); background: color-mix(in srgb, var(--yellow) 10%, transparent); border: 1px solid color-mix(in srgb, var(--yellow) 24%, transparent); border-radius: 6px; padding: 2px 8px; min-width: 52px; text-align: center; }
.hook-cmd { font-size: 11px; color: var(--ink-2); word-break: break-all; line-height: 1.5; }

/* ── PLUGINS / TILES ─────────────────────────────────────────────────────── */
.plugin-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.plugin-tile { background: var(--bg-4); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 13px 15px; display: flex; flex-direction: column; gap: 3px; transition: border-color .15s; }
.plugin-tile:hover { border-color: var(--amber); }
.plugin-off { opacity: .4; }
.plugin-dot { width: 7px; height: 7px; border-radius: 50%; margin-bottom: 6px; }
.dot-on  { background: var(--green); box-shadow: 0 0 6px color-mix(in srgb, var(--green) 60%, transparent); }
.dot-off { background: var(--ink-3); }
.plugin-nm  { font-size: 13px; font-weight: 500; color: var(--ink); }
.plugin-mkt { font-size: 11px; color: var(--ink-3); }

/* ── PROJECTS / ROWS ─────────────────────────────────────────────────────── */
.proj-list { display: flex; flex-direction: column; }
.proj-row { display: grid; grid-template-columns: 28px 1fr 140px 64px; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.proj-row:last-child { border-bottom: none; }
.proj-rank { font-size: 11px; color: var(--ink-3); }
.proj-nm { font-size: 13px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proj-bar-wrap { width: 100%; height: 6px; background: var(--bg-4); border-radius: 999px; min-width: 0; overflow: hidden; }
.proj-bar { height: 100%; background: var(--amber); border-radius: 999px; transition: width .3s ease; }
.proj-cost { font-size: 12px; color: var(--green); font-weight: 500; text-align: right; }

/* ── MCP ─────────────────────────────────────────────────────────────────── */
.mcp-cards { display: flex; flex-direction: column; gap: 10px; }
.mcp-card { background: var(--bg-4); border: 1px solid var(--line); border-left: 3px solid var(--amber); border-radius: var(--r-sm); padding: 12px 15px; }
.mcp-name { font-size: 13px; color: var(--amber); font-weight: 600; margin-bottom: 2px; }
.mcp-type { font-size: 10px; color: var(--ink-3); letter-spacing: .04em; text-transform: uppercase; margin-bottom: 6px; }
.mcp-cmd  { font-size: 11px; color: var(--ink-2); word-break: break-all; }
.mcp-env { margin-top: 6px; font-size: 10px; display: flex; flex-wrap: wrap; gap: 8px; }
.mcp-env-key { color: var(--yellow); }
.mcp-env-val { color: var(--red); }

/* ── SKILLS / BAR ROWS ───────────────────────────────────────────────────── */
.skill-list { display: flex; flex-direction: column; }
.skill-row { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--line); }
.skill-row:last-child { border-bottom: none; }
.skill-nm { font-size: 12px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skill-bar-wrap { width: 120px; height: 6px; background: var(--bg-4); border-radius: 999px; overflow: hidden; }
.skill-bar { height: 100%; background: var(--blue); border-radius: 999px; }
.skill-ct { font-size: 12px; color: var(--blue); min-width: 28px; text-align: right; font-weight: 500; }

.nil { font-size: 12px; color: var(--ink-3); font-style: italic; padding: 8px 0; }

/* ── INSTALLED SKILLS ────────────────────────────────────────────────────── */
.iskill-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.iskill-card { background: var(--bg-4); border: 1px solid var(--line); border-left: 3px solid var(--blue); border-radius: var(--r-sm); padding: 13px 15px; display: flex; flex-direction: column; gap: 5px; transition: border-color .15s; }
.iskill-card:hover { border-color: var(--amber); }
.iskill-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.iskill-name { font-size: 13px; font-weight: 600; color: var(--ink); }
.iskill-id { font-size: 10px; color: var(--blue); font-family: var(--mo); }
.iskill-desc { font-size: 12px; color: var(--ink-2); line-height: 1.5; }
.iskill-group { margin-bottom: 24px; }
.iskill-group:last-child { margin-bottom: 0; }
.iskill-group-head { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-3); padding-bottom: 8px; margin-bottom: 12px; border-bottom: 1px solid var(--line); font-weight: 600; }

/* ── LOCAL PLUGINS ───────────────────────────────────────────────────────── */
.lplugin-card { background: var(--bg-4); border: 1px solid var(--line); border-left: 3px solid var(--purple); border-radius: var(--r-sm); padding: 14px 16px; margin-bottom: 10px; }
.lplugin-card:last-child { margin-bottom: 0; }
.lplugin-header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
.lplugin-name { font-size: 14px; font-weight: 600; color: var(--ink); }
.lplugin-id { font-size: 10px; color: var(--purple); font-family: var(--mo); }
.lplugin-desc { font-size: 12px; color: var(--ink-2); margin-bottom: 10px; line-height: 1.5; }
.lplugin-cmds { display: flex; flex-wrap: wrap; gap: 6px; }

/* ── HOOK COVERAGE ───────────────────────────────────────────────────────── */
.hcov-summary { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
.hcov-bar-wrap { flex: 1; height: 6px; background: var(--bg-4); border-radius: 999px; overflow: hidden; }
.hcov-bar { height: 100%; background: linear-gradient(90deg, var(--green), var(--amber)); border-radius: 999px; transition: width .4s ease; }
.hcov-label { font-size: 12px; color: var(--green); white-space: nowrap; font-weight: 500; }
.hcev-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; margin-bottom: 14px; }
.hcev-tile { display: flex; align-items: center; gap: 8px; padding: 8px 11px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg-4); font-size: 11px; }
.hcev-on  { border-color: color-mix(in srgb, var(--green) 24%, transparent); }
.hcev-off { opacity: .4; }
.hcev-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.hcev-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
.hcev-ct { font-size: 10px; color: var(--green); background: color-mix(in srgb, var(--green) 12%, transparent); border-radius: 999px; padding: 1px 6px; min-width: 18px; text-align: center; }

/* ── VOICE ───────────────────────────────────────────────────────────────── */
.voice-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.voice-item { background: var(--bg-4); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 13px 15px; }
.voice-lbl { font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 6px; font-weight: 600; }
.voice-val { display: flex; }

.md-source { font-family: var(--mo); font-size: 12px; line-height: 1.7; color: var(--ink-2); white-space: pre-wrap; word-break: break-word; tab-size: 2; }
.rule-scope-lbl { font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 8px; font-weight: 600; }

.footer { padding: 10px 24px; font-size: 11px; color: var(--ink-3); border-top: 1px solid var(--line); background: var(--bg); flex-shrink: 0; }

/* ── AGENTS ──────────────────────────────────────────────────────────────── */
.agent-list { display: flex; flex-direction: column; gap: 10px; }
.agent-card { background: var(--bg-4); border: 1px solid var(--line); border-left: 3px solid var(--green); border-radius: var(--r-sm); padding: 13px 16px; }
.agent-name { font-size: 13px; font-weight: 600; color: var(--green); margin-bottom: 2px; }
.agent-file { font-size: 10px; color: var(--ink-3); font-family: var(--mo); margin-bottom: 5px; }
.agent-desc { font-size: 12px; color: var(--ink-2); line-height: 1.5; }

/* ── BEADS / BOARD ───────────────────────────────────────────────────────── */
/* Project picker is a horizontal pill bar (was a left side-column); issues render
   as a responsive card grid (was a one-per-row table) so the same set takes ~1/3
   the vertical space inside a bounded scroll area. */
.beads-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.bd-pills { display: flex; align-items: center; gap: 6px; overflow-x: auto; padding-bottom: 3px; flex: 1; min-width: 0; }
.bd-pill { display: flex; align-items: center; gap: 7px; flex-shrink: 0; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg-3); color: var(--ink-3); font-size: 12px; cursor: pointer; transition: all .1s; white-space: nowrap; }
.bd-pill:hover { color: var(--ink-2); border-color: var(--line-2); }
.bd-pill.active { color: var(--ink); background: var(--bg-4); border-color: var(--line-2); font-weight: 500; }
.bd-filters { display: flex; gap: 6px; flex-shrink: 0; }
.bf { background: var(--bg-4); border: 1px solid var(--line); color: var(--ink-3); font-family: var(--sans); font-size: 11px; font-weight: 500; border-radius: 999px; padding: 5px 13px; cursor: pointer; transition: all .1s; }
.bf:hover { color: var(--ink-2); border-color: var(--line-2); }
.bf.bf-active { background: color-mix(in srgb, var(--amber) 14%, transparent); border-color: color-mix(in srgb, var(--amber) 30%, transparent); color: var(--amber); }
.bd-badge { font-size: 10px; padding: 1px 7px; border-radius: 999px; flex-shrink: 0; }
.bd-badge-open   { background: color-mix(in srgb, var(--amber) 16%, transparent); color: var(--amber); }
.bd-badge-closed { background: color-mix(in srgb, var(--green) 12%, transparent); color: var(--green); }
.bd-badge-zero   { background: var(--bg-4); color: var(--ink-3); }
.bd-count { font-size: 11px; color: var(--ink-3); margin: 0 0 10px 2px; }
.bd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 12px; padding: 2px; }
.bd-card { background: var(--bg-3); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 13px 15px; cursor: pointer; display: flex; flex-direction: column; gap: 9px; min-height: 104px; box-shadow: var(--shadow); transition: border-color .12s; }
.bd-card:hover { border-color: var(--amber); }
.bd-card.is-mine { border-left: 3px solid var(--amber); }
.bd-card-top { display: flex; align-items: center; gap: 8px; }
.bd-card-dot { font-size: 13px; line-height: 1; flex-shrink: 0; }
.bd-card-id { font-family: var(--mo); font-size: 11px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.bd-card-proj { color: var(--ink-3); opacity: .8; }
.bd-card-type { margin-left: auto; flex-shrink: 0; font-size: 9px; letter-spacing: .04em; text-transform: uppercase; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line-2); }
.bd-card-title { font-size: 13px; color: var(--ink); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.bd-card-foot { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--ink-3); margin-top: auto; }
.bd-card-pri { font-family: var(--mo); }
.bd-empty { grid-column: 1 / -1; padding: 30px 16px; font-size: 12px; color: var(--ink-3); font-style: italic; text-align: center; }
/* Pager — shared by Beads board + Sessions table (true pagination, not a scroll). */
.bd-pager { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 16px; flex-wrap: wrap; }
.bd-pager button { background: var(--bg-3); border: 1px solid var(--line); color: var(--ink-2); border-radius: var(--r-sm); padding: 5px 11px; font-size: 12px; font-family: var(--sans); cursor: pointer; transition: all .1s; }
.bd-pager button:hover:not(:disabled) { border-color: var(--line-2); color: var(--ink); }
.bd-pager button:disabled { opacity: .35; cursor: default; }
.bd-pager .pg-num.active { background: color-mix(in srgb, var(--amber) 14%, transparent); border-color: color-mix(in srgb, var(--amber) 30%, transparent); color: var(--amber); }
.bd-pager .pg-ellipsis { color: var(--ink-3); padding: 0 2px; font-size: 12px; }
.bt-head { display: flex; align-items: center; padding: 9px 16px; border-bottom: 1px solid var(--line); font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }
.bt-row { display: flex; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); font-size: 12px; transition: background .08s; cursor: pointer; }
.bt-row:last-child { border-bottom: none; }
.bt-row:hover { background: var(--bg-4); }
.bt-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
.bd-id { font-family: var(--mo); font-size: 11px; color: var(--ink-3); }

/* ── BEADS DRAWER ────────────────────────────────────────────────────────── */
.bd-drawer-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 200; }
.bd-drawer-overlay.open { display: block; }
.bd-drawer { position: fixed; top: 0; right: 0; width: 480px; height: 100vh; background: var(--bg-2); border-left: 1px solid var(--line); z-index: 201; display: flex; flex-direction: column; transform: translateX(100%); transition: transform .2s cubic-bezier(.4,0,.2,1); overflow: hidden; }
.bd-drawer-overlay.open .bd-drawer { transform: translateX(0); }
.bd-drawer-head { padding: 18px 20px 14px; border-bottom: 1px solid var(--line); display: flex; align-items: flex-start; gap: 12px; flex-shrink: 0; }
.bd-drawer-title { flex: 1; font-size: 14px; font-weight: 600; color: var(--ink); line-height: 1.4; }
.bd-drawer-close { background: var(--bg-3); border: 1px solid var(--line); border-radius: var(--r-sm); color: var(--ink-3); font-size: 13px; cursor: pointer; padding: 4px 9px; flex-shrink: 0; transition: all .1s; }
.bd-drawer-close:hover { color: var(--ink); border-color: var(--line-2); }
.bd-drawer-meta { padding: 12px 20px; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 6px; flex-shrink: 0; }
.bd-meta-chip { font-size: 10px; padding: 3px 9px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg-3); color: var(--ink-3); }
.bd-drawer-body { flex: 1; overflow-y: auto; padding: 0; }
.bd-section { padding: 16px 20px; border-bottom: 1px solid var(--line); }
.bd-section:last-child { border-bottom: none; }
.bd-section-label { font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 8px; font-weight: 600; }
.bd-section-text { font-size: 12px; color: var(--ink-2); line-height: 1.65; white-space: pre-wrap; word-break: break-word; }
.bd-section-nil { font-size: 11px; color: var(--ink-3); font-style: italic; }
.bd-id-label { font-family: var(--mo); font-size: 10px; color: var(--ink-3); }

/* ── SESSIONS ────────────────────────────────────────────────────────────── */
/* Sessions now uses the Beads board chrome (.beads-toolbar / .bd-pills / .bd-pager)
   for a horizontal project picker + pagination; only the search box + row tweaks
   are session-specific. */
.sess-search { flex: 0 1 320px; background: var(--bg-4); border: 1px solid var(--line); border-radius: var(--r-sm); color: var(--ink); font-family: var(--sans); font-size: 12px; padding: 6px 11px; outline: none; transition: border-color .12s; }
.sess-search::placeholder { color: var(--ink-3); }
.sess-search:focus { border-color: var(--amber); }
#sess-rows .bt-row { align-items: flex-start; }
.sess-h { cursor: pointer; user-select: none; transition: color .1s; }
.sess-h:hover { color: var(--ink-2); }
.sess-caret { color: var(--amber); font-size: 9px; }
.sess-select { flex: 0 0 240px; max-width: 240px; background: var(--bg-4); border: 1px solid var(--line); border-radius: var(--r-sm); color: var(--ink); font-family: var(--sans); font-size: 12px; padding: 6px 11px; outline: none; cursor: pointer; transition: border-color .12s; }
.sess-select:focus, .sess-select:hover { border-color: var(--line-2); }
.sess-more-wrap { display: flex; justify-content: center; margin-top: 14px; }
.sess-more { background: var(--bg-3); border: 1px solid var(--line); color: var(--ink-2); border-radius: var(--r-sm); padding: 8px 20px; font-size: 12px; font-family: var(--sans); cursor: pointer; transition: all .1s; }
.sess-more:hover { border-color: var(--amber); color: var(--ink); }
.sess-resume { background: var(--bg-4); border: 1px solid var(--line); border-radius: var(--r-sm); color: var(--ink-2); font-family: var(--sans); font-size: 11px; font-weight: 500; padding: 4px 10px; cursor: pointer; transition: all .1s; white-space: nowrap; }
.sess-resume:hover { color: var(--amber); border-color: var(--amber); }
.sess-resume.sess-copied { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }

/* chart canvases live in fixed-height boxes the panels provide */
canvas { max-width: 100%; }
</style>`;
}

export function renderTopbar(acct, ts) {
  return `<div class="topbar">
  <div class="topbar-logo"><span class="brain">🧠</span> Braynee</div>
  <div class="topbar-sep">/</div>
  <div class="topbar-sub">Second Brain</div>
  <div class="topbar-account">
    <span class="acct-email">${esc(acct.emailAddress || '')}</span>
    <span class="acct-badge">${esc(acct.organizationRole || 'user')}</span>
    ${acct.billingType ? `<span class="acct-badge">${esc(acct.billingType)}</span>` : ''}
    <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="Toggle light / dark">🌙</button>
  </div>
</div>`;
}

export function renderSidebar() {
  return `<nav class="sidebar">
  <div class="nav-item active" onclick="nav('braynee',this)"><span class="nav-icon">🧠</span> <strong>Braynee</strong></div>
  <div class="sidebar-section">Claude Code</div>
  <div class="nav-item" onclick="nav('general',this)"><span class="nav-icon">⚙️</span> General</div>
  <div class="nav-item" onclick="nav('permissions',this)"><span class="nav-icon">🔐</span> Permissions</div>
  <div class="nav-item" onclick="nav('hooks',this)"><span class="nav-icon">🪝</span> Hooks</div>
  <div class="nav-item" onclick="nav('plugins',this)"><span class="nav-icon">🧩</span> Plugins</div>
  <div class="nav-item" onclick="nav('mcp',this)"><span class="nav-icon">🔌</span> MCP Servers</div>
  <div class="nav-item" onclick="nav('agents',this)"><span class="nav-icon">🤖</span> Agents</div>
  <div class="sidebar-section">User Settings</div>
  <div class="nav-item" onclick="nav('claudemd',this)"><span class="nav-icon">📄</span> CLAUDE.md</div>
  <div class="nav-item" onclick="nav('rules',this)"><span class="nav-icon">📐</span> Rules</div>
  <div class="nav-item" onclick="nav('prefs',this)"><span class="nav-icon">🎛️</span> Preferences</div>
  <div class="sidebar-section">Data</div>
  <div class="nav-item" onclick="nav('sessions',this)"><span class="nav-icon">💬</span> Sessions</div>
  <div class="nav-item" onclick="nav('projects',this)"><span class="nav-icon">📁</span> Projects</div>
  <div class="nav-item" onclick="nav('skills',this)"><span class="nav-icon">📊</span> Skill Usage</div>
  <div class="nav-item" onclick="nav('iskills',this)"><span class="nav-icon">🧰</span> Installed Skills</div>
  <div class="nav-item" onclick="nav('lplugins',this)"><span class="nav-icon">🗂️</span> Local Plugins</div>
  <div class="sidebar-section">Insights</div>
  <div class="nav-item" onclick="nav('analytics',this)"><span class="nav-icon">📈</span> Analytics</div>
  <div class="nav-item" onclick="nav('tools',this)"><span class="nav-icon">🔧</span> Tool Usage</div>
  <div class="nav-item" onclick="nav('iprojects',this)"><span class="nav-icon">⏱️</span> Project Hours</div>
  <div class="nav-item" onclick="nav('beads',this)"><span class="nav-icon">🔗</span> Beads</div>
</nav>`;
}

export function renderNavJS(opts = {}) {
  const liveReload = !opts.artifact;
  return `<script>
let _beadsTimer = null;

function toggleTheme() {
  var isLight = document.documentElement.classList.toggle('light');
  try { localStorage.setItem('braynee-theme', isLight ? 'light' : 'dark'); } catch(e) {}
  var btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = isLight ? '☀️' : '🌙';
  // charts read CSS vars at build time — re-render the active panel on theme flip
  var active = sessionStorage.getItem('braynee-panel') || 'braynee';
  if (window._bvRenderPanel) window._bvRenderPanel(active);
}

function nav(id, el) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('panel-' + id).classList.add('active');
  el.classList.add('active');
  sessionStorage.setItem('braynee-panel', id);
  if (window._bvRenderPanel) window._bvRenderPanel(id);
  if (_beadsTimer) { clearInterval(_beadsTimer); _beadsTimer = null; }
  ${liveReload ? `if (id === 'beads') { _beadsTimer = setInterval(() => location.reload(), 30000); }` : ``}
}

(function() {
  // restore theme
  try {
    if (localStorage.getItem('braynee-theme') === 'light') {
      document.documentElement.classList.add('light');
      var b = document.getElementById('themeToggle'); if (b) b.textContent = '☀️';
    }
  } catch(e) {}
  const saved = sessionStorage.getItem('braynee-panel') || 'braynee';
  const panel = document.getElementById('panel-' + saved);
  if (panel) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    panel.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => {
      if (n.getAttribute('onclick') === "nav('" + saved + "',this)") n.classList.add('active');
    });
    ${liveReload ? `if (saved === 'beads') { _beadsTimer = setInterval(() => location.reload(), 30000); }` : ``}
  }
  if (window._bvRenderPanel) window._bvRenderPanel(saved);
  renderBeads();
})();
</script>`;
}
