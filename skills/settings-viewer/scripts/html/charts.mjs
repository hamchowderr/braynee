// Chart support for the Second Brain Dashboard.
//
// Chart.js is VENDORED + INLINED (never a CDN) so file mode, server mode, and the
// offline portable artifact all render charts with no network access.
//
// Two Chart.js gotchas (learned in the dashboard mockup) are handled here:
//   1. a canvas needs a fixed-height, position:relative parent or it grows forever
//      → panels wrap each <canvas> in a sized box (see the panel markup);
//   2. a canvas built while its panel is display:none measures 0×0 → panels REGISTER
//      a renderer and nav() fires it on requestAnimationFrame once the panel is
//      visible, with animation off (snap straight to the final frame).
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
let _chartSrc = '';
try {
  _chartSrc = readFileSync(join(here, '..', 'vendor', 'chart.umd.min.js'), 'utf8');
} catch { /* no vendored lib → charts degrade to nothing, panels keep working */ }

export function chartsAvailable() { return !!_chartSrc; }

// The inlined library (goes in <head>).
export function renderChartLib() {
  return _chartSrc ? `<script>${_chartSrc}</script>` : '';
}

// JSON safe to inline inside a <script> — only the `<` that could start a stray
// </script> needs escaping (proven in the Analytics panel; deliberately NOT
// touching U+2028/2029 — a literal of those in source is itself a JS line break).
const jsonForScript = obj => JSON.stringify(obj ?? {}).replace(/</g, '\\u003c');

// A sized, position:relative canvas box. A canvas without a fixed-height parent
// grows forever; panels wrap every <canvas> in one of these.
export function chartBox(id, height = 280) {
  return `<div style="position:relative;height:${height}px"><canvas id="${id}"></canvas></div>`;
}

// Pick a canvas height for a horizontal bar chart from its row count.
export function barChartHeight(count, { row = 26, pad = 56, min = 160, max = 820 } = {}) {
  return Math.max(min, Math.min(max, count * row + pad));
}

// Emit a <script> that lazily renders ONE bar chart for a panel. dataObj is a flat
// {label:number}; it's sorted desc and capped to `limit` client-side. Renderers
// CHAIN per panelId (prev() then this), so a panel can host several charts.
export function renderBarChartJS(panelId, canvasId, dataObj, opts = {}) {
  if (!_chartSrc) return '';
  const { color = '#f5a623', horizontal = true, limit = 30, suffix = '' } = opts;
  const axis = horizontal ? 'x' : 'y';
  return `<script>
(function(){
  if(!window.bvChart){ return; }
  var D = ${jsonForScript(dataObj)};
  var prev = window._bvPanelRenderers['${panelId}'];
  function render(){
    var e = Object.entries(D).sort(function(a,b){return b[1]-a[1];}).slice(0, ${limit});
    if(!e.length) return;
    var g = bvGrid();
    bvChart('${canvasId}', {
      type:'bar',
      data:{ labels:e.map(function(x){return x[0];}), datasets:[{ data:e.map(function(x){return x[1];}), backgroundColor:'${color}', borderRadius:3, maxBarThickness:22 }] },
      options:{ indexAxis:'${horizontal ? 'y' : 'x'}',
        plugins:{ legend:{display:false}, tooltip:{ displayColors:false, callbacks:{ label:function(c){ return c.parsed.${axis} + '${suffix}'; } } } },
        scales:{ x:Object.assign({beginAtZero:true},g), y:Object.assign({beginAtZero:true},g) } }
    });
  }
  window._bvPanelRenderers['${panelId}'] = prev ? function(){ prev(); render(); } : render;
})();
</script>`;
}

// Shared runtime: theme bound to the dashboard CSS vars + a lazy per-panel render
// registry. Panels do `window._bvPanelRenderers['<panelId>'] = () => { ... }` and
// nav() calls `window._bvRenderPanel('<panelId>')` when the panel becomes visible.
export function renderChartRuntime() {
  if (!_chartSrc) return '';
  return `<script>
(function(){
  function tok(n){return ((getComputedStyle(document.documentElement).getPropertyValue(n))||'').trim()||'#888';}
  window._bvTok = tok;
  window._bvCharts = {};
  window._bvPanelRenderers = {};
  window.bvChart = function(id, cfg){
    var el = document.getElementById(id); if(!el || typeof Chart==='undefined') return;
    if(window._bvCharts[id]) window._bvCharts[id].destroy();
    Chart.defaults.font.family = "'IBM Plex Mono', monospace";
    Chart.defaults.font.size = 10;
    Chart.defaults.color = tok('--ink-3');
    cfg.options = cfg.options || {};
    cfg.options.animation = false;
    cfg.options.responsive = true;
    cfg.options.maintainAspectRatio = false;
    window._bvCharts[id] = new Chart(el, cfg);
  };
  window.bvGrid = function(){ return {grid:{color:'rgba(255,255,255,.06)',drawBorder:false},ticks:{color:tok('--ink-3')}}; };
  // controlled categorical palette — amber lead, no six-color clash
  window._bvPalette = ['#f5a623','#3ddc84','#5bc0f8','#b48eff','#f5d76e','#ff5c5c','#9e9890'];
  window._bvRenderPanel = function(id){
    var fn = window._bvPanelRenderers[id];
    if(fn){ requestAnimationFrame(function(){ try{ fn(); }catch(e){} }); }
  };
})();
</script>`;
}
