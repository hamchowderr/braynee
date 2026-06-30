import { chartBox, barChartHeight, renderBarChartJS } from '../html/charts.mjs';

export function renderAnalyticsPanel(d) {
  const { insights, ig } = d;
  const sessionCount = ig.data_sources?.facet_files ?? ig.sources?.facet_files ?? 0;
  // Each chart needs a fixed-height, position:relative box (else the canvas grows
  // forever). The lazy renderer in renderAnalyticsJS fills these once the panel shows.
  const canvas = (id, h = 220) => `<div style="position:relative;height:${h}px"><canvas id="${id}"></canvas></div>`;
  return `<div id="panel-analytics" class="panel">
    <div class="section-head">
      <div class="section-title">Analytics</div>
      <div class="section-tag">from insightful-data.json · ${sessionCount} sessions analyzed</div>
    </div>
    ${!insights ? `<div class="card"><div class="card-body"><p class="nil">— insightful-data.json not found at ~/.claude/usage-data/ — run /insightful to generate it —</p></div></div>` : `
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

// Real charts for the Analytics panel (replaces the old fake div-bars). Data is
// JSON-embedded; the renderer is registered and fired lazily by nav() when the
// panel becomes visible (canvases in a hidden panel measure 0×0).
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
  if(!window.bvChart){ console.warn('[bv] analytics: bvChart undefined at register time'); return; }
  var D = ${JSON.stringify(data).replace(/</g, '\u003c')};
  function ent(o, lim){ var e=Object.entries(o||{}).sort(function(a,b){return b[1]-a[1];}); return lim?e.slice(0,lim):e; }
  function donut(id, o){ var e=ent(o); if(!e.length) return;
    bvChart(id, {
      type:'doughnut',
      data:{ labels:e.map(function(x){return x[0];}), datasets:[{ data:e.map(function(x){return x[1];}), backgroundColor:window._bvPalette, borderWidth:2, borderColor:_bvTok('--bg-3') }] },
      options:{ cutout:'62%', plugins:{ legend:{ position:'bottom', labels:{ boxWidth:8, boxHeight:8, usePointStyle:true, padding:10, font:{ size:9 } } } } }
    });
  }
  function bars(id, o, color, horiz, lim){ var e=ent(o,lim); if(!e.length) return; var g=bvGrid();
    bvChart(id, {
      type:'bar',
      data:{ labels:e.map(function(x){return x[0];}), datasets:[{ data:e.map(function(x){return x[1];}), backgroundColor:color||'#f5a623', borderRadius:3 }] },
      options:{ indexAxis:horiz?'y':'x', plugins:{ legend:{ display:false }, tooltip:{ displayColors:false } }, scales:{ x:Object.assign({beginAtZero:true},g), y:Object.assign({beginAtZero:true},g) } }
    });
  }
  window._bvPanelRenderers['analytics'] = function(){
    donut('an-outcomes', D.outcomes);
    bars('an-types', D.types, '#5bc0f8');
    bars('an-help', D.help, '#b48eff');
    bars('an-success', D.success, '#f5a623');
    donut('an-sat', D.sat);
    bars('an-friction', D.friction, '#ff5c5c');
    bars('an-goals', D.goals, '#5bc0f8', true, 12);
  };
  console.log('[bv] analytics renderer registered; keys=', Object.keys(window._bvPanelRenderers));
})();
</script>`;
}

export function renderToolUsagePanel(d) {
  const { ig } = d;
  const tools = ig.global_tool_totals ?? ig.tools ?? {};
  const n = Math.min(30, Object.keys(tools).length);
  return `<div id="panel-tools" class="panel">
    <div class="section-head">
      <div class="section-title">Tool Usage</div>
      <div class="section-tag">all-time call counts across tracked sessions · top ${n}</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>Tool Call Totals</div>
      <div class="card-body">${Object.keys(tools).length ? chartBox('tools-chart', barChartHeight(n)) : `<p class="nil">— no data —</p>`}</div>
    </div>
  </div>`;
}

export function renderToolUsageJS(d) {
  const { ig } = d;
  const tools = ig.global_tool_totals ?? ig.tools ?? {};
  return renderBarChartJS('tools', 'tools-chart', tools, { color: '#f5a623', horizontal: true, limit: 30 });
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
