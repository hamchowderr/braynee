import { esc } from '../html/utils.mjs';

// Sessions panel — browse + search EVERY Claude Code session on disk, not just
// the ~50 the native /resume picker shows per folder.
//
// Scales to thousands of sessions across ~90 projects (cp-1g78): the project
// selector is a DROPDOWN (a 90-pill row was unnavigable), and the list grows by
// "Load more" rather than 160+ discrete pages. Recent-first sort + a date-range
// toggle + free-text search are the find tools; the embedded dataset is filtered,
// sorted and sliced client-side, so all of it is instant.

const INITIAL = 25;   // rows shown first
const STEP = 25;      // rows added per "Load more"

export function renderSessionsPanel(d) {
  const s = d.sessionsData || { sessions: [], totalSessions: 0, totalSizeBytes: 0, projectCount: 0, oldestMs: 0, newestMs: 0 };
  const sizeGB = (s.totalSizeBytes / 1024 / 1024 / 1024).toFixed(2);
  const fmt = ms => ms ? new Date(ms).toISOString().slice(0, 10) : '—';

  const byProject = new Map();
  for (const sess of s.sessions) byProject.set(sess.project, (byProject.get(sess.project) || 0) + 1);
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
        <strong style="color:var(--amber)">Past the picker.</strong> The native <code>/resume</code> list only shows the most recent sessions per folder — these are <em>all</em> of them. Pick a project, narrow by date, or search across everything. Hit <strong>resume</strong> to copy that session's <code>claude --resume</code> command, then run it from the project directory shown under each preview.
      </div>
    </div>

    ${s.totalSessions === 0
      ? `<div class="card"><div class="card-body"><p class="nil">— no sessions found under ~/.claude/projects/ —</p></div></div>`
      : `<div class="beads-toolbar">
      <select id="sess-proj-select" class="sess-select" onchange="selectSessProjVal(this.value)">
        <option value="__all__">All Projects (${s.totalSessions})</option>
        ${projects.map(([name, count]) => `<option value="${esc(name)}">${esc(name)} (${count})</option>`).join('')}
      </select>
      <div class="bd-filters">
        <button class="bf bf-active" onclick="sessRange(this,'all')">All</button>
        <button class="bf" onclick="sessRange(this,'30d')">30d</button>
        <button class="bf" onclick="sessRange(this,'7d')">7d</button>
      </div>
      <input id="sess-search" class="sess-search" type="text" placeholder="search prompt, project, or id…" oninput="searchSessions(this.value)" autocomplete="off" spellcheck="false">
    </div>
    <div class="bd-count" id="sess-count"></div>
    <div class="card" style="padding:0">
      <div class="bt-head">
        <span class="bt-cell sess-h" onclick="sessSort('date')" style="flex:0 0 86px">Date <span class="sess-caret" id="sess-ct-date"></span></span>
        <span class="bt-cell sess-h" onclick="sessSort('project')" style="flex:0 0 110px">Project <span class="sess-caret" id="sess-ct-project"></span></span>
        <span class="bt-cell" style="flex:1">First Message</span>
        <span class="bt-cell sess-h" onclick="sessSort('size')" style="flex:0 0 52px;text-align:right">Size <span class="sess-caret" id="sess-ct-size"></span></span>
        <span class="bt-cell" style="flex:0 0 92px;text-align:right">Resume</span>
      </div>
      <div id="sess-rows"></div>
    </div>
    <div class="sess-more-wrap" id="sess-more"></div>`}
  </div>`;
}

export function renderSessionsJS(d) {
  const s = d.sessionsData || { sessions: [] };
  return `<script>
const SESSIONS_DATA = ${JSON.stringify(s.sessions)};
const SESS_INITIAL = ${INITIAL};
const SESS_STEP = ${STEP};
const SESS_NOW = ${Date.now()};            // build-time reference for date ranges
let _sessProj = '__all__';
let _sessQuery = '';
let _sessShown = SESS_INITIAL;             // how many rows are currently rendered
let _sessSort = { key: 'date', dir: 'desc' };
let _sessRange = 'all';

function _sessEsc(x){return String(x==null?'':x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function _sessDate(ms){try{return new Date(ms).toISOString().slice(0,10);}catch(e){return '—';}}
function _sessSize(b){if(b>=1048576)return (b/1048576).toFixed(1)+'M';if(b>=1024)return Math.round(b/1024)+'K';return b+'B';}

function _sessCmp(a,b){
  const k=_sessSort.key, d2=_sessSort.dir==='asc'?1:-1; let av,bv;
  if(k==='size'){ av=a.sizeBytes; bv=b.sizeBytes; }
  else if(k==='project'){ av=(a.project||'').toLowerCase(); bv=(b.project||'').toLowerCase(); }
  else { av=a.mtimeMs; bv=b.mtimeMs; }
  return (av<bv?-1:av>bv?1:0)*d2;
}
function _sessUpdateHeaders(){
  ['date','project','size'].forEach(function(k){
    const el=document.getElementById('sess-ct-'+k);
    if(el) el.textContent = _sessSort.key===k ? (_sessSort.dir==='asc'?'▲':'▼') : '';
  });
}

function selectSessProjVal(v){ _sessProj=v||'__all__'; _sessShown=SESS_INITIAL; renderSessions(); }
function searchSessions(v){ _sessQuery=v||''; _sessShown=SESS_INITIAL; renderSessions(); }
function sessRange(el,range){
  document.querySelectorAll('#panel-sessions .bd-filters .bf').forEach(b=>b.classList.remove('bf-active'));
  el.classList.add('bf-active');
  _sessRange=range; _sessShown=SESS_INITIAL; renderSessions();
}
function sessSort(key){
  if(_sessSort.key===key) _sessSort.dir = _sessSort.dir==='asc'?'desc':'asc';
  else { _sessSort.key=key; _sessSort.dir = key==='project'?'asc':'desc'; }
  _sessShown=SESS_INITIAL; renderSessions();
}
function sessLoadMore(){ _sessShown += SESS_STEP; renderSessions(); }

function renderSessions(){
  const rows=document.getElementById('sess-rows');
  const count=document.getElementById('sess-count');
  const more=document.getElementById('sess-more');
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
  if(_sessRange!=='all'){
    const days=_sessRange==='7d'?7:30;
    const cutoff=SESS_NOW-days*86400000;
    list=list.filter(s=>s.mtimeMs>=cutoff);
  }
  list=list.slice().sort(_sessCmp);   // slice so we never mutate SESSIONS_DATA
  _sessUpdateHeaders();
  const scope=_sessProj==='__all__'?'':' · '+_sessProj;
  if(!list.length){
    if(count)count.textContent='0 sessions'+scope;
    rows.innerHTML='<div style="padding:20px 16px;font-size:11px;color:var(--ink-3)">— no matching sessions —</div>';
    if(more)more.innerHTML='';
    return;
  }
  if(_sessShown>list.length)_sessShown=list.length;
  const shown=list.slice(0,_sessShown);
  if(count)count.textContent='Showing '+shown.length+' of '+list.length+scope;
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
  if(more){
    const rem=list.length-shown.length;
    more.innerHTML = rem>0 ? '<button class="sess-more" onclick="sessLoadMore()">Load '+Math.min(SESS_STEP,rem)+' more · '+rem+' remaining</button>' : '';
  }
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
