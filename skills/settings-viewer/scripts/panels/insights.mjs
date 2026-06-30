import { esc } from '../html/utils.mjs';
import { chartBox, barChartHeight, renderBarChartJS } from '../html/charts.mjs';

// Small helpers shared by the panels below.
const _sum = o => Object.values(o || {}).reduce((a, b) => a + (+b || 0), 0);
const _cap = s => String(s || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
// Real facet categories only — insightful pollutes some facets with one-off
// free-text sentence keys; keep snake_case-ish keys (no spaces, <=40 chars).
const _topRealKey = o => Object.entries(o || {})
  .filter(([k]) => !/\s/.test(k) && k.length <= 40)
  .sort((a, b) => b[1] - a[1])[0]?.[0] || '—';

function kpiBox(num, lbl, color, big = true) {
  return `<div class="stat-box"><div class="stat-num" style="color:${color};${big ? '' : 'font-size:16px'}">${num}</div><div class="stat-lbl">${lbl}</div></div>`;
}

export function renderAnalyticsPanel(d) {
  const { insights, ig } = d;
  const f = ig.facets_summary || {};
  const sessionCount = ig.data_sources?.facet_files ?? ig.sources?.facet_files ?? f.total ?? 0;
  const canvas = (id, h = 220) => `<div style="position:relative;height:${h}px"><canvas id="${id}"></canvas></div>`;

  // KPI headline computed from the CLEAN facets (outcomes/friction/satisfaction
  // are clean; goal/success are filtered via _topRealKey).
  const oc = f.outcomes || {};
  const ocTotal = _sum(oc);
  const achieved = (oc.achieved || 0) + (oc.fully_achieved || 0) + (oc.mostly_achieved || 0);
  const successRate = ocTotal ? Math.round((achieved / ocTotal) * 100) : 0;
  const topFriction = _cap(_topRealKey(f.friction_counts));
  const topGoal = _cap(_topRealKey(f.goal_categories));

  return `<div id="panel-analytics" class="panel">
    <div class="section-head">
      <div class="section-title">Analytics</div>
      <div class="section-tag">from insightful-data.json · ${sessionCount} sessions analyzed</div>
    </div>
    ${!insights ? `<div class="card"><div class="card-body"><p class="nil">— insightful-data.json not found at ~/.claude/usage-data/ — run /insightful to generate it —</p></div></div>` : `
    <div class="stats" style="grid-template-columns:repeat(4,1fr)">
      ${kpiBox(sessionCount, 'Sessions Analyzed', 'var(--blue)')}
      ${kpiBox(successRate + '<span style="font-size:16px">%</span>', 'Success Rate', 'var(--green)')}
      ${kpiBox(esc(topFriction), 'Top Friction', 'var(--red)', false)}
      ${kpiBox(esc(topGoal), 'Top Goal', 'var(--amber)', false)}
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--green)"></div>Session Outcomes</div>
        <div class="card-body">${canvas('an-outcomes')}</div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--blue)"></div>Session Types</div>
        <div class="card-body">${canvas('an-types')}</div>
      </div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--purple)"></div>Helpfulness</div>
        <div class="card-body">${canvas('an-help')}</div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--amber)"></div>Primary Successes</div>
        <div class="card-body">${canvas('an-success')}</div>
      </div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--yellow)"></div>User Satisfaction</div>
        <div class="card-body">${canvas('an-sat')}</div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--red)"></div>Friction Points</div>
        <div class="card-body">${canvas('an-friction')}</div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>Top Goal Categories</div>
      <div class="card-body">${canvas('an-goals', 300)}</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>Data Sources &amp; Accounting</div>
      <div class="card-body">${`<table class="kv">${Object.entries({ ...(ig.message_accounting ?? ig.accounting ?? {}), ...(ig.data_sources ?? ig.sources ?? {}) }).map(([k, v]) => `<tr><td class="prop">${k}</td><td class="val-cell"><span class="scalar">${v}</span></td></tr>`).join('')}</table>`}</div>
    </div>
    `}
  </div>`;
}

// Charts for the Analytics panel. ent() drops free-text facet noise (keys with
// spaces or >40 chars — e.g. the polluted primary_successes facet) and caps to a
// top-N, and labels are humanized (snake_case → Title Case). Registered lazily and
// fired by nav() when the panel is visible (hidden-panel canvases measure 0×0).
export function renderAnalyticsJS(d) {
  const { insights, ig } = d;
  if (!insights) return '';
  const f = ig.facets_summary || {};
  const data = {
    outcomes: f.outcomes || {},
    types: f.session_types || {},
    help: f.helpfulness_counts || {},
    success: f.primary_successes || {},
    sat: f.satisfaction_counts || {},
    friction: f.friction_counts || {},
    goals: f.goal_categories || {},
  };
  return `<script>
(function(){
  if(!window.bvChart){ return; }
  var D = ${JSON.stringify(data).replace(/</g, '\\u003c')};
  function cap(s){ return String(s).replace(/_/g,' ').replace(/^\\w/,function(c){return c.toUpperCase();}); }
  function ent(o, lim){
    var e=Object.entries(o||{})
      .filter(function(x){ return !/\\s/.test(x[0]) && x[0].length<=40; })  // drop free-text facet noise
      .sort(function(a,b){return b[1]-a[1];});
    return e.slice(0, lim||10);
  }
  function donut(id, o){ var e=ent(o); if(!e.length) return;
    bvChart(id, {
      type:'doughnut',
      data:{ labels:e.map(function(x){return cap(x[0]);}), datasets:[{ data:e.map(function(x){return x[1];}), backgroundColor:window._bvPalette, borderWidth:2, borderColor:_bvTok('--bg-3') }] },
      options:{ cutout:'62%', plugins:{ legend:{ position:'bottom', labels:{ boxWidth:8, boxHeight:8, usePointStyle:true, padding:10, font:{ size:9 } } } } }
    });
  }
  function bars(id, o, color, horiz, lim){ var e=ent(o, lim||12); if(!e.length) return; var g=bvGrid();
    bvChart(id, {
      type:'bar',
      data:{ labels:e.map(function(x){return cap(x[0]);}), datasets:[{ data:e.map(function(x){return x[1];}), backgroundColor:color||'#f5a623', borderRadius:3 }] },
      options:{ indexAxis:horiz?'y':'x', plugins:{ legend:{ display:false }, tooltip:{ displayColors:false } }, scales:{ x:Object.assign({beginAtZero:true},g), y:Object.assign({beginAtZero:true},g) } }
    });
  }
  window._bvPanelRenderers['analytics'] = function(){
    donut('an-outcomes', D.outcomes);
    bars('an-types', D.types, '#5bc0f8');
    bars('an-help', D.help, '#b48eff');
    bars('an-success', D.success, '#f5a623', true);
    donut('an-sat', D.sat);
    bars('an-friction', D.friction, '#ff5c5c');
    bars('an-goals', D.goals, '#5bc0f8', true, 12);
  };
})();
</script>`;
}

export function renderToolUsagePanel(d) {
  const { ig } = d;
  const tools = ig.global_tool_totals ?? ig.tools ?? {};
  const keys = Object.keys(tools);
  const n = Math.min(30, keys.length);
  let native = 0, mcp = 0;
  for (const [k, v] of Object.entries(tools)) { if (k.startsWith('mcp__')) mcp += v; else native += v; }
  const total = native + mcp;
  const busiest = Object.entries(tools).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
  const pct = total ? Math.round((mcp / total) * 100) : 0;
  const mcpByServer = {};
  for (const [k, v] of Object.entries(tools)) { if (k.startsWith('mcp__')) { const srv = k.split('__')[1] || '?'; mcpByServer[srv] = (mcpByServer[srv] || 0) + v; } }
  const mcpSummary = Object.entries(mcpByServer).sort((a, b) => b[1] - a[1]).map(([s, v]) => `${s} ${v.toLocaleString()}`).join(' · ') || 'none';

  return `<div id="panel-tools" class="panel">
    <div class="section-head">
      <div class="section-title">Tool Usage</div>
      <div class="section-tag">all-time call counts across tracked sessions · top ${n}</div>
    </div>
    ${!keys.length ? `<div class="card"><div class="card-body"><p class="nil">— no data —</p></div></div>` : `
    <div class="stats" style="grid-template-columns:repeat(4,1fr)">
      ${kpiBox(total.toLocaleString(), 'Total Calls', 'var(--amber)')}
      ${kpiBox(keys.length, 'Distinct Tools', 'var(--blue)')}
      ${kpiBox((100 - pct) + '<span style="font-size:15px">% / </span>' + pct + '<span style="font-size:15px">%</span>', 'Native / MCP', 'var(--green)')}
      ${kpiBox(esc(busiest), 'Busiest', 'var(--purple)', false)}
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--green)"></div>Native vs MCP</div>
        <div class="card-body">${chartBox('tools-split', 200)}</div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-head-dot"></div>Split</div>
        <div class="card-body" style="font-size:12px;color:var(--ink-2);line-height:1.8">
          <div><span style="color:var(--amber)">●</span> Native: <strong>${native.toLocaleString()}</strong> calls</div>
          <div><span style="color:var(--blue)">●</span> MCP: <strong>${mcp.toLocaleString()}</strong> calls &nbsp;<span style="color:var(--ink-3)">(${esc(mcpSummary)})</span></div>
          <div style="color:var(--ink-3);margin-top:8px">Busiest: <strong style="color:var(--ink)">${esc(busiest)}</strong> (${(tools[busiest] || 0).toLocaleString()})</div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>Tool Call Totals</div>
      <div class="card-body">${chartBox('tools-chart', barChartHeight(n))}</div>
    </div>
    `}
  </div>`;
}

export function renderToolUsageJS(d) {
  const { ig } = d;
  const tools = ig.global_tool_totals ?? ig.tools ?? {};
  let native = 0, mcp = 0;
  for (const [k, v] of Object.entries(tools)) { if (k.startsWith('mcp__')) mcp += v; else native += v; }
  const payload = { tools, split: { Native: native, MCP: mcp } };
  return `<script>
(function(){
  if(!window.bvChart){ return; }
  var D = ${JSON.stringify(payload).replace(/</g, '\\u003c')};
  function render(){
    var e=Object.entries(D.tools).sort(function(a,b){return b[1]-a[1];}).slice(0,30);
    if(e.length){ var g=bvGrid();
      bvChart('tools-chart', {
        type:'bar',
        data:{ labels:e.map(function(x){return x[0];}), datasets:[{ data:e.map(function(x){return x[1];}),
          backgroundColor:e.map(function(x){return x[0].indexOf('mcp__')===0?'#5bc0f8':'#f5a623';}), borderRadius:3, maxBarThickness:22 }] },
        options:{ indexAxis:'y', plugins:{ legend:{display:false}, tooltip:{displayColors:false} }, scales:{ x:Object.assign({beginAtZero:true},g), y:Object.assign({beginAtZero:true},g) } }
      });
    }
    var s=Object.entries(D.split).filter(function(x){return x[1]>0;});
    if(s.length){ bvChart('tools-split', {
      type:'doughnut',
      data:{ labels:s.map(function(x){return x[0];}), datasets:[{ data:s.map(function(x){return x[1];}), backgroundColor:['#f5a623','#5bc0f8'], borderWidth:2, borderColor:_bvTok('--bg-3') }] },
      options:{ cutout:'62%', plugins:{ legend:{ position:'bottom', labels:{ boxWidth:8, boxHeight:8, usePointStyle:true, padding:10, font:{ size:10 } } } } }
    }); }
  }
  var prev=window._bvPanelRenderers['tools'];
  window._bvPanelRenderers['tools'] = prev ? function(){ prev(); render(); } : render;
})();
</script>`;
}

export function renderProjectHoursPanel(d) {
  const { insights } = d;
  const projects = insights?.projects || {};
  const n = Math.min(25, Object.keys(projects).length);
  return `<div id="panel-iprojects" class="panel">
    <div class="section-head">
      <div class="section-title">Project Hours</div>
      <div class="section-tag">from insightful-data.json · top ${n} by hours</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot" style="background:var(--purple)"></div>Hours by Project</div>
      <div class="card-body">${Object.keys(projects).length ? chartBox('iprojects-chart', barChartHeight(n)) : `<p class="nil">— no data —</p>`}</div>
    </div>
  </div>`;
}

export function renderProjectHoursJS(d) {
  const { insights } = d;
  const projects = insights?.projects || {};
  const hours = {};
  for (const [name, x] of Object.entries(projects)) hours[name] = Math.round((x.total_hours || 0) * 10) / 10;
  return renderBarChartJS('iprojects', 'iprojects-chart', hours, { color: '#b48eff', horizontal: true, limit: 25, suffix: 'h' });
}
