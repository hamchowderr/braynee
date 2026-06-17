import { esc } from '../html/utils.mjs';

// Sessions panel — browse + search EVERY Claude Code session on disk, not just
// the ~50 the native /resume picker shows per folder.
//
// Layout mirrors the Beads panel: a project sidebar on the left (click to scope),
// a search box that spans ALL projects, and a row per session. The full dataset
// is embedded once and a client-side renderer filters it, so browsing + search
// are instant. The dashboard can't launch a terminal, so each row's action is a
// one-click copy of `claude --resume <id>` (run it from the shown project dir).

const VISIBLE_CAP = 250; // DOM rows rendered at once; search/scope re-filter the full set

export function renderSessionsPanel(d) {
  const s = d.sessionsData || { sessions: [], totalSessions: 0, totalSizeBytes: 0, projectCount: 0, oldestMs: 0, newestMs: 0 };
  const sizeGB = (s.totalSizeBytes / 1024 / 1024 / 1024).toFixed(2);
  const fmt = ms => ms ? new Date(ms).toISOString().slice(0, 10) : '—';

  // Project sidebar: one entry per project, most sessions first.
  const byProject = new Map();
  for (const sess of s.sessions) {
    byProject.set(sess.project, (byProject.get(sess.project) || 0) + 1);
  }
  const projects = [...byProject.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return `<div id="panel-sessions" class="panel">
    <div class="section-head">
      <div class="section-title">Sessions</div>
      <div class="section-tag">${s.totalSessions} resumable · source: ~/.claude/projects/</div>
    </div>

    <div class="stats" style="grid-template-columns:repeat(4,1fr)">
      <div class="stat-box"><div class="stat-num" style="color:var(--amber)">${s.totalSessions}</div><div class="stat-lbl">Sessions</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--blue)">${s.projectCount}</div><div class="stat-lbl">Projects</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--green)">${sizeGB}<span style="font-size:16px">GB</span></div><div class="stat-lbl">On Disk</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--purple);font-size:18px">${fmt(s.oldestMs)}</div><div class="stat-lbl">Oldest Session</div></div>
    </div>

    <div class="card" style="margin-bottom:14px;border-color:rgba(245,166,35,.2);background:rgba(245,166,35,.03)">
      <div class="card-body" style="font-size:11px;color:var(--ink-2);padding:10px 16px;line-height:1.6">
        <strong style="color:var(--amber)">Past the picker.</strong> The native <code>/resume</code> list only shows the most recent sessions per folder — these are <em>all</em> of them. Pick a project to browse it, or search across everything. Hit <strong>resume</strong> to copy that session's <code>claude --resume</code> command, then run it from the project directory shown under each preview.
      </div>
    </div>

    ${s.totalSessions === 0
      ? `<div class="card"><div class="card-body"><p class="nil">— no sessions found under ~/.claude/projects/ —</p></div></div>`
      : `<div class="beads-layout">
      <div class="beads-proj-sidebar">
        <div class="beads-proj-item active" data-proj="__all__" onclick="selectSessProj(this)">
          <span class="bd-proj-name" style="font-weight:500">All Projects</span>
          <span class="bd-badge bd-badge-open">${s.totalSessions}</span>
        </div>
        ${projects.map(([name, count]) => `
        <div class="beads-proj-item" data-proj="${esc(name)}" onclick="selectSessProj(this)">
          <span class="bd-proj-name" title="${esc(name)}">${esc(name)}</span>
          <span class="bd-badge bd-badge-zero">${count}</span>
        </div>`).join('')}
      </div>
      <div class="beads-main">
        <div class="beads-filters">
          <input id="sess-search" class="sess-search" type="text" placeholder="search prompt, project, or id…" oninput="searchSessions(this.value)" autocomplete="off" spellcheck="false">
          <span id="sess-count" style="margin-left:auto;font-size:10px;color:var(--ink-3);text-transform:none;letter-spacing:0"></span>
        </div>
        <div class="bt-head">
          <span class="bt-cell" style="flex:0 0 86px">Date</span>
          <span class="bt-cell" style="flex:0 0 110px">Project</span>
          <span class="bt-cell" style="flex:1">First Message</span>
          <span class="bt-cell" style="flex:0 0 52px;text-align:right">Size</span>
          <span class="bt-cell" style="flex:0 0 92px;text-align:right">Resume</span>
        </div>
        <div id="sess-rows"></div>
      </div>
    </div>`}
  </div>`;
}

export function renderSessionsJS(d) {
  const s = d.sessionsData || { sessions: [] };
  return `<script>
const SESSIONS_DATA = ${JSON.stringify(s.sessions)};
const SESS_CAP = ${VISIBLE_CAP};
let _sessProj = '__all__';
let _sessQuery = '';

function _sessEsc(x){return String(x==null?'':x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function _sessDate(ms){try{return new Date(ms).toISOString().slice(0,10);}catch(e){return '—';}}
function _sessSize(b){if(b>=1048576)return (b/1048576).toFixed(1)+'M';if(b>=1024)return Math.round(b/1024)+'K';return b+'B';}

function selectSessProj(el){
  document.querySelectorAll('#panel-sessions .beads-proj-item').forEach(i=>i.classList.remove('active'));
  el.classList.add('active');
  _sessProj=el.dataset.proj;
  renderSessions();
}
function searchSessions(v){_sessQuery=v||'';renderSessions();}

function renderSessions(){
  const rows=document.getElementById('sess-rows');
  const count=document.getElementById('sess-count');
  if(!rows)return;
  let list=SESSIONS_DATA;
  if(_sessProj!=='__all__') list=list.filter(s=>s.project===_sessProj);
  const q=_sessQuery.trim().toLowerCase();
  if(q){
    const terms=q.split(/\\s+/);
    list=list.filter(s=>{
      const hay=((s.preview||'')+' '+(s.project||'')+' '+(s.id||'')+' '+(s.cwd||'')+' '+_sessDate(s.mtimeMs)).toLowerCase();
      return terms.every(t=>hay.includes(t));
    });
  }
  const shown=list.slice(0,SESS_CAP);
  if(count) count.textContent='showing '+shown.length+' of '+list.length+(list.length>SESS_CAP?' · refine to see more':'');
  if(!shown.length){rows.innerHTML='<div style="padding:20px 16px;font-size:11px;color:var(--ink-3)">— no matching sessions —</div>';return;}
  rows.innerHTML=shown.map(s=>{
    const preview=s.preview?_sessEsc(s.preview):'<span style="color:var(--ink-3);font-style:italic">(no preview)</span>';
    const branch=s.gitBranch?' <span style="color:var(--ink-3)">· '+_sessEsc(s.gitBranch)+'</span>':'';
    return '<div class="bt-row" style="cursor:default">'
      +'<span class="bt-cell" style="flex:0 0 86px;color:var(--ink-3)">'+_sessDate(s.mtimeMs)+'</span>'
      +'<span class="bt-cell" style="flex:0 0 110px;color:var(--blue)" title="'+_sessEsc(s.cwd)+'">'+_sessEsc(s.project)+'</span>'
      +'<span class="bt-cell" style="flex:1;white-space:normal;min-width:0">'
        +'<span style="color:var(--ink);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+preview+'</span>'
        +'<span style="color:var(--ink-3);font-size:9px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+_sessEsc(s.cwd)+branch+'</span>'
      +'</span>'
      +'<span class="bt-cell" style="flex:0 0 52px;text-align:right;color:var(--ink-3)">'+_sessSize(s.sizeBytes)+'</span>'
      +'<span class="bt-cell" style="flex:0 0 92px;text-align:right">'
        +'<button class="sess-resume" onclick="copyResume(\\''+_sessEsc(s.id)+'\\',this)" title="copy: claude --resume '+_sessEsc(s.id)+'">resume ⧉</button>'
      +'</span>'
    +'</div>';
  }).join('');
}

function copyResume(id,btn){
  const cmd='claude --resume '+id;
  const ok=()=>{const o=btn.textContent;btn.textContent='copied ✓';btn.classList.add('sess-copied');setTimeout(()=>{btn.textContent=o;btn.classList.remove('sess-copied');},1200);};
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(cmd).then(ok).catch(()=>_sessCopyFallback(cmd,ok));}
  else _sessCopyFallback(cmd,ok);
}
function _sessCopyFallback(text,ok){
  try{const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.focus();ta.select();document.execCommand('copy');document.body.removeChild(ta);ok();}catch(e){}
}

renderSessions();
</script>`;
}
