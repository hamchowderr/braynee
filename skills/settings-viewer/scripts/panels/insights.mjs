import { rankBars, insightsProjRows } from '../html/utils.mjs';

export function renderAnalyticsPanel(d) {
  const { insights, ig } = d;
  const sessionCount = ig.data_sources?.facet_files ?? ig.sources?.facet_files ?? 0;
  return `<div id="panel-analytics" class="panel">
    <div class="section-head">
      <div class="section-title">Analytics</div>
      <div class="section-tag">from insightful-data.json · ${sessionCount} sessions analyzed</div>
    </div>
    ${!insights ? `<div class="card"><div class="card-body"><p class="nil">— insightful-data.json not found at ~/.claude/usage-data/ — run /insightful to generate it —</p></div></div>` : `
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--green)"></div>Session Outcomes</div>
        <div class="card-body">${rankBars(ig.facets_summary?.outcomes, 'var(--green)')}</div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--blue)"></div>Session Types</div>
        <div class="card-body">${rankBars(ig.facets_summary?.session_types, 'var(--blue)')}</div>
      </div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--purple)"></div>Helpfulness</div>
        <div class="card-body">${rankBars(ig.facets_summary?.helpfulness_counts, 'var(--purple)')}</div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--amber)"></div>Primary Successes</div>
        <div class="card-body">${rankBars(ig.facets_summary?.primary_successes, 'var(--amber)')}</div>
      </div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--yellow)"></div>User Satisfaction</div>
        <div class="card-body">${rankBars(ig.facets_summary?.satisfaction_counts, 'var(--yellow)')}</div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-head-dot" style="background:var(--red)"></div>Friction Points</div>
        <div class="card-body">${rankBars(ig.facets_summary?.friction_counts, 'var(--red)')}</div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>Top Goal Categories</div>
      <div class="card-body">${rankBars(ig.facets_summary?.goal_categories, 'var(--blue)', 30)}</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>Data Sources &amp; Accounting</div>
      <div class="card-body">${`<table class="kv">${Object.entries({ ...(ig.message_accounting ?? ig.accounting ?? {}), ...(ig.data_sources ?? ig.sources ?? {}) }).map(([k, v]) => `<tr><td class="prop">${k}</td><td class="val-cell"><span class="scalar">${v}</span></td></tr>`).join('')}</table>`}</div>
    </div>
    `}
  </div>`;
}

export function renderToolUsagePanel(d) {
  const { ig } = d;
  return `<div id="panel-tools" class="panel">
    <div class="section-head">
      <div class="section-title">Tool Usage</div>
      <div class="section-tag">all-time call counts across tracked sessions</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>Tool Call Totals</div>
      <div class="card-body">${rankBars(ig.global_tool_totals ?? ig.tools, 'var(--amber)', 40)}</div>
    </div>
  </div>`;
}

export function renderProjectHoursPanel(d) {
  const { insights } = d;
  const projectCount = Object.keys(insights?.projects || {}).length;
  return `<div id="panel-iprojects" class="panel">
    <div class="section-head">
      <div class="section-title">Project Hours</div>
      <div class="section-tag">from insightful-data.json · all tracked projects ranked by hours</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-head-dot"></div>${projectCount} Projects</div>
      <div class="card-body">${insightsProjRows(insights?.projects)}</div>
    </div>
  </div>`;
}
