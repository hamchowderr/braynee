import { esc } from '../html/utils.mjs';

// Sessions panel — browse + search EVERY Claude Code session on disk, not just
// the ~50 the native /resume picker shows per folder.
//
// Layout mirrors the Beads board: a horizontal project pill bar (click to scope),
// a search box that spans ALL projects, and a paginated row-per-session table. The
// full dataset is embedded once and a client-side renderer filters + pages it, so
// browsing + search are instant and you page through rather than scroll a wall.
// The dashboard can't launch a terminal, so each row's action is a one-click copy
// of `claude --resume <id>` (run it from the shown project dir).

const PAGE_SIZE = 15; // rows per page — paginate instead of one long scroll

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
      : `<div class="beads-toolbar">
      <div class="bd-pills">
        <div class="bd-pill active" data-proj="__all__" onclick="selectSessProj(this)">All Projects <span class="bd-badge bd-badge-open">${s.totalSessions}</span></div>
        ${projects.map(([name, count]) => `<div class="bd-pill" data-proj="${esc(name)}" onclick="selectSessProj(this)" title="${esc(name)}">${esc(name)} <span class="bd-badge bd-badge-zero">${count}</span></div>`).join('')}
      </div>
      <input id="sess-search" class="sess-search" type="text" placeholder="search prompt, project, or id…" oninput="searchSessions(this.value)" autocomplete="off" spellcheck="false">
    </div>
    <div class="bd-count" id="sess-count"></div>
    <div class="card" style="padding:0">
      <div class="bt-head">
        <span class="bt-cell" style="flex:0 0 86px">Date</span>
        <span class="bt-cell" style="flex:0 0 110px">Project</span>
        <span class="bt-cell" style="flex:1">First Message</span>
        <span class="bt-cell" style="flex:0 0 52px;text-align:right">Size</span>
        <span class="bt-cell" style="flex:0 0 92px;text-align:right">Resume</span>
      </div>
      <div id="sess-rows"></div>
    </div>
    <div class="bd-pager" id="sess-pager"></div>`}
  </div>`;
}

export function renderSessionsJS(d) {
  const s = d.sessionsData || { sessions: [] };
  return `<script>
const SESSIONS_DATA = ${JSON.stringify(s.sessions)};
const SESS_PAGE_SIZE = ${PAGE_SIZE};
let _sessProj = '__all__';
let _sessQuery = '';
let _sessPage = 1;

function _sessEsc(x){return String(x==null?'':x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function _sessDate(ms){try{return new Date(ms).toISOString().slice(0,10);}catch(e){return '—';}}
function _sessSize(b){if(b>=1048576)return (b/1048576).toFixed(1)+'M';if(b>=1024)return Math.round(b/1024)+'K';return b+'B';}

function selectSessProj(el){
  document.querySelectorAll('#panel-sessions .bd-pill').forEach(i=>i.classList.remove('active'));
  el.classList.add('active');
  _sessProj=el.dataset.proj;
  _sessPage=1;
  renderSessions();
}
function searchSessions(v){_sessQuery=v||'';_sessPage=1;renderSessions();}

function _sessPagerHtml(page,pages){
  const win=[],add=n=>{if(n>=1&&n<=pages&&win.indexOf(n)===-1)win.push(n);};
  add(1);add(2);add(page-1);add(page);add(page+1);add(pages-1);add(pages);
  win.sort((a,b)=>a-b);
  let html='<button onclick="sessGoPage('+(page-1)+')"'+(page<=1?' disabled':'')+'>‹ Prev</button>';
  let prev=0;
  for(const n of win){
    if(n-prev>1)html+='<span class="pg-ellipsis">…</span>';
    html+='<button class="pg-num'+(n===page?' active':'')+'" onclick="sessGoPage('+n+')">'+n+'</button>';
    prev=n;
  }
  html+='<button onclick="sessGoPage('+(page+1)+')"'+(page>=pages?' disabled':'')+'>Next ›</button>';
  return html;
}
function sessGoPage(n){if(n<1)return;_sessPage=n;renderSessions();const m=document.querySelector('.main');if(m)m.scrollTop=0;}

function renderSessions(){
  const rows=document.getElementById('sess-rows');
  const count=document.getElementById('sess-count');
  const pager=document.getElementById('sess-pager');
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
  const scope=_sessProj==='__all__'?'':' · '+_sessProj;
  if(!list.length){
    if(count)count.textContent='0 sessions'+scope;
    rows.innerHTML='<div style="padding:20px 16px;font-size:11px;color:var(--ink-3)">— no matching sessions —</div>';
    if(pager)pager.innerHTML='';
    return;
  }
  const pages=Math.max(1,Math.ceil(list.length/SESS_PAGE_SIZE));
  if(_sessPage>pages)_sessPage=pages;
  if(_sessPage<1)_sessPage=1;
  const start=(_sessPage-1)*SESS_PAGE_SIZE;
  const shown=list.slice(start,start+SESS_PAGE_SIZE);
  if(count)count.textContent='Showing '+(start+1)+'–'+(start+shown.length)+' of '+list.length+scope;
  if(pager)pager.innerHTML=pages>1?_sessPagerHtml(_sessPage,pages):'';
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
