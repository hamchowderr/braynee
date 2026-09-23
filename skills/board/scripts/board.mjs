#!/usr/bin/env node
// Beads board — renders one repo's beads backlog as a single self-contained
// HTML page for a published artifact. Every repo gets the same page: status
// tiles, open PRs and deploys, epic progress, a board per milestone, the
// build-order diagram, one record per issue, derived check-ins and a done
// archive. Only the accent colour changes between projects.
//
// Read-only: it runs `bd export`, `bd comments`, `gh pr list` and `gh api`
// inside the repo and writes one file OUTSIDE it. It never writes bd data.
//
// Usage:
//   node board.mjs <repo> [--out <file>] [--name "<Project>"] [--accent <#hex>]
//                  [--from <previous-board.html>] [--log <legacy-log.json>]
// --from reads the accent (and name) back out of a previously published board,
// so a project keeps its colour without any config in the repo.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename, dirname, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

// ---- args ---------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const repoArg = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
if (!repoArg || argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node board.mjs <repo> [--out <file>] [--name "<Project>"] [--accent <#hex>] [--from <previous.html>] [--log <legacy.json>]');
  process.exit(repoArg ? 0 : 1);
}
const REPO = resolve(repoArg);
if (!existsSync(resolve(REPO, '.beads'))) { console.error(`no .beads directory in ${REPO}`); process.exit(1); }

const prev = flag('--from') && existsSync(flag('--from')) ? readFileSync(flag('--from'), 'utf8') : '';
const prevMeta = (n) => prev.match(new RegExp(`<meta name="board-${n}" content="([^"]*)"`))?.[1] || null;
const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const NAME = flag('--name') || prevMeta('name') || titleCase(basename(REPO));
const HEX = /^#[0-9a-fA-F]{6}$/;
const ACCENT = [flag('--accent'), prevMeta('accent'), '#0f766e'].find(v => v && HEX.test(v));
const SLUG = NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const OUT = resolve(flag('--out') || resolve(tmpdir(), `${SLUG}-board.html`));
const rel = relative(REPO, OUT);
if (!rel.startsWith('..') && !isAbsolute(rel)) { console.error(`refusing to write inside the repo: ${OUT}`); process.exit(1); }

function run(cmd, args, fallback) {
  try { return execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 128 * 1024 * 1024 }); }
  catch { return fallback; }
}
const json = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

// ---- data ---------------------------------------------------------------
let issues = run('bd', ['export'], '').split('\n').filter(Boolean).map(l => json(l, null))
  .filter(r => r && (r._type ?? 'issue') === 'issue' && r.id && r.title);
if (!issues.length) issues = json(run('bd', ['list', '--all', '-n', '0', '--json'], '[]'), []);
if (!issues.length) { console.error('bd returned no issues'); process.exit(1); }

for (const i of issues) {
  if (!Array.isArray(i.comments)) i.comments = i.comment_count > 0 ? json(run('bd', ['comments', i.id, '--json'], '[]'), []) : [];
  i.meta = typeof i.metadata === 'string' ? json(i.metadata || '{}', {}) : (i.metadata || {});
  i.labels = i.labels || [];
}

const originUrl = run('git', ['remote', 'get-url', 'origin'], '').trim();
const ownerRepo = originUrl.match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?$/)?.[1] || '';
const repoUrl = ownerRepo ? `https://github.com/${ownerRepo}` : '';
const branch = run('git', ['branch', '--show-current'], '').trim();
const prs = json(run('gh', ['pr', 'list', '--state', 'all', '--limit', '300', '--json',
  'number,title,headRefName,url,state,body,isDraft,createdAt,mergedAt,closedAt'], '[]'), []);

// Deploys: GitHub deployments from the last 30 days, latest per environment.
const deploys = [];
if (ownerRepo) {
  const since = Date.now() - 30 * 864e5;
  const list = json(run('gh', ['api', `repos/${ownerRepo}/deployments?per_page=50`], '[]'), [])
    .filter(d => Date.parse(d.created_at) >= since);
  const seen = new Set();
  for (const d of list) {
    if (seen.has(d.environment) || seen.size >= 8) continue;
    seen.add(d.environment);
    const st = json(run('gh', ['api', `repos/${ownerRepo}/deployments/${d.id}/statuses?per_page=1`], '[]'), [])[0];
    if (st?.environment_url) deploys.push({ env: d.environment, ref: d.ref, url: st.environment_url, state: st.state, at: st.created_at });
  }
}

// Legacy hand-kept check-in notes ({at, note}[]) from an older generator.
const legacy = flag('--log') && existsSync(flag('--log')) ? json(readFileSync(flag('--log'), 'utf8'), []) : [];

// ---- derive -------------------------------------------------------------
const byId = new Map(issues.map(i => [i.id, i]));
const prefix = (() => { const m = issues[0].id.match(/^(.*)-[^-]+$/); return m ? m[1] : ''; })();
const shortId = (id) => prefix && id.startsWith(prefix + '-') ? id.slice(prefix.length + 1) : id;
for (const i of issues) { i.blockers = []; i.unblocks = []; i.parent = null; i.children = []; i.related = []; }
for (const i of issues) for (const d of i.dependencies || []) {
  const other = byId.get(d.depends_on_id);
  if (!other || other === i) continue;
  if (d.type === 'parent-child') { i.parent = other; other.children.push(i); }
  else if (d.type === 'blocks') { i.blockers.push(other); other.unblocks.push(i); }
  else i.related.push({ type: d.type, issue: other });
}

const prByNumber = new Map(prs.map(p => [String(p.number), p]));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function prsFor(i) {
  const out = [];
  const ref = String(i.external_ref || '').match(/^gh-(\d+)$/);
  if (ref && prByNumber.has(ref[1])) out.push(prByNumber.get(ref[1]));
  const full = new RegExp(`(?<![\\w.-])${escRe(i.id)}(?![\\w-]|\\.\\w)`);
  const short = new RegExp('`' + escRe(shortId(i.id)) + '`');
  for (const p of prs) {
    if (out.includes(p)) continue;
    const text = `${p.headRefName}\n${p.title}\n${p.body || ''}`;
    if (full.test(text) || (prefix && short.test(p.body || ''))) out.push(p);
  }
  return out.sort((a, b) => b.number - a.number);
}
for (const i of issues) { i.prs = prsFor(i); i.openPr = i.prs.find(p => p.state === 'OPEN') || null; i.pr = i.openPr || i.prs[0] || null; }

const open = (i) => i.status !== 'closed';
function laneOf(i) {
  if (i.status === 'closed') return 'done';
  if (i.status === 'deferred') return 'deferred';
  if (i.openPr) return 'review';
  if (i.status === 'in_progress' || i.status === 'hooked') return 'progress';
  if (i.status === 'blocked' || i.blockers.some(open)) return 'queued';
  return 'ready';
}
const LANES = [
  ['queued', 'Queued', 'waiting on a dependency'],
  ['ready', 'Ready', 'no blockers, unclaimed'],
  ['progress', 'In progress', 'claimed'],
  ['review', 'In review', 'pull request open'],
  ['done', 'Done', 'closed'],
];
const LANE_LABEL = { ...Object.fromEntries(LANES.map(([k, l]) => [k, l])), deferred: 'Deferred' };
const counts = { queued: 0, ready: 0, progress: 0, review: 0, done: 0, deferred: 0 };
for (const i of issues) { i.lane = laneOf(i); counts[i.lane]++; }

const PRIO = ['P0', 'P1', 'P2', 'P3', 'P4'];
const prioOf = (i) => PRIO[i.priority] || 'P4';
const day = (s) => String(s || '').slice(0, 10);
const closedDesc = (a, b) => String(b.closed_at || '').localeCompare(String(a.closed_at || ''));

// Milestones come from `milestone:<name>` labels (underscores read as spaces),
// ordered by when their first issue was created. No labels: one board.
const msOf = (i) => (i.labels.find(l => l.startsWith('milestone:'))?.slice(10).replace(/_/g, ' ')) || null;
const usesMilestones = issues.some(msOf);
const msName = (i) => usesMilestones ? (msOf(i) || 'Unassigned') : 'All work';
const milestones = [...new Set(issues.map(msName))].sort((a, b) => {
  if (a === 'Unassigned') return 1; if (b === 'Unassigned') return -1;
  const first = (m) => issues.filter(i => msName(i) === m).map(i => i.created_at).sort()[0] || '';
  return first(a).localeCompare(first(b)) || a.localeCompare(b);
});
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Build order: an issue sits one level right of its deepest blocker or parent.
const level = new Map();
function depth(i, seen = new Set()) {
  if (level.has(i.id)) return level.get(i.id);
  if (seen.has(i.id)) return 0;
  seen.add(i.id);
  const ups = [...i.blockers, ...(i.parent ? [i.parent] : [])];
  const d = ups.length ? 1 + Math.max(...ups.map(x => depth(x, seen))) : 0;
  level.set(i.id, d);
  return d;
}
issues.forEach(i => depth(i));
const buildOrder = [...issues].sort((a, b) => (level.get(a.id) - level.get(b.id)) || (a.priority - b.priority) || a.id.localeCompare(b.id));

// The diagram shows every issue on a small project. On a large one it shows
// each connected group that still holds open work, plus open loose issues.
const SMALL = issues.length <= 80;
const neighbours = (i) => [...i.blockers, ...i.unblocks, ...i.children, ...(i.parent ? [i.parent] : [])];
const component = new Map();
for (const i of issues) {
  if (component.has(i.id)) continue;
  const stack = [i], members = [];
  component.set(i.id, members);
  while (stack.length) { const x = stack.pop(); members.push(x); for (const n of neighbours(x)) if (!component.has(n.id)) { component.set(n.id, members); stack.push(n); } }
}
const inDiagram = new Set(buildOrder.filter(i => SMALL || component.get(i.id).some(open)).map(i => i.id));

// Check-ins, derived: bd create/close times, bd comments (the human notes),
// PR opened/merged/closed times, and any legacy notes. Grouped by day.
const events = [];
const ilinkShort = (i) => `<a href="#${anchor(i.id)}"><code>${esc(shortId(i.id))}</code></a> ${esc(short(i.title, 90))}`;
for (const i of issues) {
  if (i.created_at) events.push({ at: i.created_at, kind: 'opened', html: `Opened ${ilinkShort(i)}` });
  if (i.closed_at) events.push({ at: i.closed_at, kind: 'closed', html: `Closed ${ilinkShort(i)}${i.close_reason ? ` <span class="muted">— ${esc(short(i.close_reason, 140))}</span>` : ''}` });
  for (const c of i.comments) {
    const at = c.created_at || c.createdAt; const text = c.text || c.body || c.comment || '';
    if (at && text) events.push({ at, kind: 'note', html: `<div class="note-on">on ${ilinkShort(i)}${c.author ? ` · ${esc(who(c.author))}` : ''}</div><div class="note-body">${md(text)}</div>` });
  }
}
for (const p of prs) {
  const pr = `<a href="${esc(p.url)}">PR #${p.number}</a> ${esc(short(p.title, 90))}`;
  if (p.createdAt) events.push({ at: p.createdAt, kind: 'pr', html: `Opened ${pr}` });
  if (p.mergedAt) events.push({ at: p.mergedAt, kind: 'merged', html: `Merged ${pr}` });
  else if (p.state === 'CLOSED' && p.closedAt) events.push({ at: p.closedAt, kind: 'pr', html: `Closed without merging ${pr}` });
}
for (const e of legacy) if (e && e.at && e.note) events.push({ at: String(e.at).replace(' ', 'T'), kind: 'note', html: `<div class="note-body">${md(e.note)}</div>` });
events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
const days = [];
for (const e of events) { const d = day(e.at); if (!days.length || days[days.length - 1].d !== d) days.push({ d, items: [] }); days[days.length - 1].items.push(e); }

// ---- html helpers ---------------------------------------------------------
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function short(s, n = 110) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function anchor(id) { return `issue-${id}`; }
// Boards are often shared by link: show the name part of an email, never the address.
function who(s) { return s ? String(s).split('@')[0] : '—'; }
const safeUrl = (u) => /^https?:\/\//i.test(u) ? u : '#';

// Minimal, escaped markdown: headings, bullet and numbered lists, fenced code,
// `code`, **bold**, [text](http…) links. Raw HTML is always escaped.
function md(text) {
  if (!text || !String(text).trim()) return '';
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);
  const src = String(text).replace(/\r\n/g, '\n');
  const parts = src.split(/(```[\s\S]*?```)/g);
  return parts.map(part => {
    if (part.startsWith('```')) return `<pre><code>${esc(part.replace(/^```[^\n]*\n?/, '').replace(/```$/, ''))}</code></pre>`;
    return part.split(/\n{2,}/).filter(b => b.trim()).map(b => {
      const lines = b.split('\n').filter(l => l.trim());
      if (lines.every(l => /^\s*[-*]\s+/.test(l))) return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
      if (lines.every(l => /^\s*\d+[.)]\s+/.test(l))) return `<ol>${lines.map(l => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
      if (/^#{1,6}\s/.test(lines[0])) return `<h5>${inline(lines[0].replace(/^#+\s/, ''))}</h5>` + (lines.length > 1 ? `<p>${lines.slice(1).map(inline).join('<br>')}</p>` : '');
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('');
  }).join('');
}

const prTag = (p) => p ? `<a class="pr" href="${esc(p.url)}">PR #${p.number}${p.state === 'MERGED' ? ' merged' : p.state === 'CLOSED' ? ' closed' : p.isDraft ? ' draft' : ''}</a>` : '';
const pill = (lane) => `<span class="pill pill-${lane}">${esc(LANE_LABEL[lane])}</span>`;
const prio = (i) => `<span class="prio ${prioOf(i)}">${prioOf(i)}</span>`;
const ilink = (i) => `<a class="ilink${i.status === 'closed' ? ' closed' : ''}" href="#${anchor(i.id)}"><code>${esc(shortId(i.id))}</code> ${esc(short(i.title, 60))}</a>`;

function card(i) {
  const blockers = i.blockers.filter(open);
  return `<article class="card lane-${i.lane}">
    <header>${prio(i)}<a class="id" href="#${anchor(i.id)}">${esc(shortId(i.id))}</a><span class="type">${esc(i.issue_type || 'task')}</span>${i.lane === 'progress' ? `<span class="owner">${esc(i.assignee ? who(i.assignee) : 'claimed')}</span>` : ''}</header>
    <h4><a href="#${anchor(i.id)}">${esc(i.title)}</a></h4>
    ${i.description ? `<p>${esc(short(i.description))}</p>` : ''}
    <footer>${blockers.length ? `<span>blocked by ${blockers.map(b => `<a href="#${anchor(b.id)}"><code>${esc(shortId(b.id))}</code></a>`).join(' ')}</span>` : ''}${i.parent ? `<span>in <a href="#${anchor(i.parent.id)}"><code>${esc(shortId(i.parent.id))}</code></a></span>` : ''}${prTag(i.pr)}</footer>
  </article>`;
}

const DONE_ON_BOARD = 8;
function milestoneBoard(ms) {
  const items = issues.filter(i => msName(i) === ms && i.lane !== 'deferred');
  const deferred = issues.filter(i => msName(i) === ms && i.lane === 'deferred');
  const done = items.filter(i => i.lane === 'done').length;
  const pct = items.length ? Math.round(done / items.length * 100) : 0;
  const cols = LANES.map(([k, label]) => {
    let inLane = items.filter(i => i.lane === k);
    let more = '';
    if (k === 'done') { inLane.sort(closedDesc); if (inLane.length > DONE_ON_BOARD) { more = `<a class="more" href="#done">+${inLane.length - DONE_ON_BOARD} more in the done archive</a>`; inLane = inLane.slice(0, DONE_ON_BOARD); } }
    else inLane.sort((a, b) => (a.priority - b.priority) || (level.get(a.id) - level.get(b.id)));
    return `<div class="col"><div class="colhead"><span>${label}</span><span class="n">${items.filter(i => i.lane === k).length}</span></div>${inLane.map(card).join('') || '<div class="empty">none</div>'}${more}</div>`;
  }).join('');
  return `<section class="ms" id="board-${slug(ms)}" data-ms="${slug(ms)}" hidden>
    <div class="mshead"><h3>${esc(ms)}</h3><span class="bar" role="img" aria-label="${done} of ${items.length} done"><span style="width:${pct}%"></span></span><span class="n">${done} / ${items.length} done</span></div>
    <div class="board">${cols}</div>
    ${deferred.length ? `<div class="deferred"><div class="colhead"><span>Deferred</span><span class="n">${deferred.length}</span></div><div class="dgrid">${deferred.map(card).join('')}</div></div>` : ''}
  </section>`;
}

function orderSvg() {
  const nodes = buildOrder.filter(i => inDiagram.has(i.id));
  const levels = [...new Set(nodes.map(i => level.get(i.id)))].sort((a, b) => a - b);
  const col = new Map(levels.map((l, n) => [l, n]));
  const W = 240, H = 52, GX = 64, GY = 14, PAD = 16;
  const pos = new Map(); let maxRows = 1;
  for (const l of levels) {
    const rows = nodes.filter(i => level.get(i.id) === l);
    maxRows = Math.max(maxRows, rows.length);
    rows.forEach((i, r) => pos.set(i.id, { x: PAD + col.get(l) * (W + GX), y: PAD + r * (H + GY) }));
  }
  const width = PAD * 2 + levels.length * W + Math.max(0, levels.length - 1) * GX;
  const height = PAD * 2 + maxRows * H + (maxRows - 1) * GY;
  const curve = (a, b) => { const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, c = Math.max(24, (x2 - x1) / 2); return `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2 - 4},${y2}`; };
  const edges = [];
  for (const i of nodes) {
    const b = pos.get(i.id);
    if (i.parent && pos.get(i.parent.id)) edges.push(`<path d="${curve(pos.get(i.parent.id), b)}" class="edge edge-child"/>`);
    for (const d of i.blockers) { const a = pos.get(d.id); if (a) edges.push(`<path d="${curve(a, b)}" class="edge edge-block${d.status === 'closed' ? ' edge-done' : ''}" marker-end="url(#${d.status === 'closed' ? 'hd' : 'hb'})"/>`); }
  }
  const boxes = nodes.map(i => { const p = pos.get(i.id); return `<a href="#${anchor(i.id)}"><g class="node lane-${i.lane}" transform="translate(${p.x},${p.y})">
    <title>${esc(i.id)} — ${esc(i.title)}</title><rect width="${W}" height="${H}" rx="6"/>
    <text x="12" y="20" class="nid">${esc(shortId(i.id))} · ${prioOf(i)} · ${esc(LANE_LABEL[i.lane])}</text>
    <text x="12" y="39" class="ntitle">${esc(short(i.title, 32))}</text></g></a>`; }).join('');
  const marker = (id, cls) => `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,1 L9,5 L0,9 z" class="${cls}"/></marker>`;
  return { count: nodes.length, svg: `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Build order, left to right; each box opens its issue"><defs>${marker('hb', 'head')}${marker('hd', 'head head-done')}</defs>${edges.join('')}${boxes}</svg>` };
}

function issueDetail(i, n) {
  const prev = buildOrder[n - 2], next = buildOrder[n];
  const exec = Object.keys(i.meta).filter(k => k.startsWith('execution_'));
  const otherMeta = Object.keys(i.meta).filter(k => !k.startsWith('execution_'));
  const field = (label, body) => `<div class="field"><div class="flabel">${label}</div><div class="fbody">${body || '<span class="muted">not written yet</span>'}</div></div>`;
  const list = (arr, none) => arr.length ? arr.map(x => `<div>${ilink(x)}</div>`).join('') : `<span class="muted">${none}</span>`;
  return `<article class="issue lane-${i.lane}" id="${anchor(i.id)}" hidden>
    <div class="ihead"><span class="n">${n}</span>${prio(i)}<code class="id">${esc(i.id)}</code>${pill(i.lane)}<span class="muted">${esc(i.issue_type || 'task')}</span>${usesMilestones ? `<span class="muted">· ${esc(msName(i))}</span>` : ''}</div>
    <h3>${esc(i.title)}</h3>
    <div class="igrid">
      <div class="imain">
        ${field('Description', md(i.description))}
        ${field('Design', md(i.design))}
        ${field('Acceptance', md(i.acceptance_criteria))}
        ${field('Notes', md(i.notes))}
        ${i.close_reason ? field('Close reason', md(i.close_reason)) : ''}
        ${i.comments.length ? field(`Comments (${i.comments.length})`, i.comments.map(c => `<div class="comment"><div class="muted">${esc(day(c.created_at || c.createdAt))}${c.author ? ` · ${esc(who(c.author))}` : ''}</div>${md(c.text || c.body || c.comment || '')}</div>`).join('')) : ''}
      </div>
      <aside class="iside">
        ${i.parent ? field('Parent', `<div>${ilink(i.parent)}</div>`) : ''}
        ${i.children.length ? field(`Children (${i.children.filter(c => c.status === 'closed').length}/${i.children.length} done)`, list(i.children, '')) : ''}
        ${field('Blocked by', list(i.blockers, 'nothing, this is an entry point'))}
        ${field('Unblocks', list(i.unblocks, 'nothing downstream'))}
        ${i.related.length ? field('Related', i.related.map(r => `<div><span class="muted">${esc(r.type)}</span> ${ilink(r.issue)}</div>`).join('')) : ''}
        ${field('Pull requests', i.prs.length ? i.prs.map(p => `<div>${prTag(p)} <span class="muted">${esc(short(p.title, 44))}</span></div>`).join('') : '<span class="muted">none yet</span>')}
        ${field('Execution', exec.length ? `<dl class="kv">${exec.map(k => `<dt>${esc(k.replace('execution_', '').replace(/_/g, ' '))}</dt><dd>${esc(i.meta[k])}</dd>`).join('')}</dl>` : '<span class="muted">session defaults</span>')}
        ${otherMeta.length ? field('Metadata', `<dl class="kv">${otherMeta.map(k => `<dt>${esc(k)}</dt><dd>${esc(typeof i.meta[k] === 'object' ? JSON.stringify(i.meta[k]) : i.meta[k])}</dd>`).join('')}</dl>`) : ''}
        ${field('Record', `<dl class="kv"><dt>owner</dt><dd>${esc(who(i.assignee || i.owner))}</dd><dt>created</dt><dd>${esc(day(i.created_at))}</dd>${i.started_at ? `<dt>started</dt><dd>${esc(day(i.started_at))}</dd>` : ''}<dt>updated</dt><dd>${esc(day(i.updated_at))}</dd>${i.closed_at ? `<dt>closed</dt><dd>${esc(day(i.closed_at))}</dd>` : ''}${i.external_ref ? `<dt>ref</dt><dd>${esc(i.external_ref)}</dd>` : ''}${i.labels.length ? `<dt>labels</dt><dd>${esc(i.labels.join(', '))}</dd>` : ''}<dt>level</dt><dd>${level.get(i.id)}</dd></dl>`)}
      </aside>
    </div>
    <div class="ifoot"><span>${prev ? `<a href="#${anchor(prev.id)}">← ${esc(shortId(prev.id))}</a>` : ''}</span><span><a href="#issues">All issues</a> · <a href="#board">Board</a></span><span>${next ? `<a href="#${anchor(next.id)}">${esc(shortId(next.id))} →</a>` : ''}</span></div>
  </article>`;
}

const irow = (i, n) => `<a class="irow lane-${i.lane}" href="#${anchor(i.id)}"><span class="n">${n}</span>${prio(i)}<code>${esc(shortId(i.id))}</code><span class="t">${esc(i.title)}</span>${pill(i.lane)}</a>`;

// ---- status view parts ----------------------------------------------------
const openPrs = prs.filter(p => p.state === 'OPEN');
const prIssues = (p) => issues.filter(i => i.prs.includes(p));
const previewFor = (p) => deploys.find(d => d.ref === p.headRefName);
const prsHtml = openPrs.length ? `<ul class="plist">${openPrs.map(p => { const pv = previewFor(p); return `<li><div class="phead">${prTag(p)} <span>${esc(p.title)}</span></div><div class="muted small"><code>${esc(p.headRefName)}</code>${pv ? ` · preview <a href="${esc(safeUrl(pv.url))}">${esc(pv.url.replace(/^https?:\/\//, ''))}</a> <span class="muted">(${esc(pv.state)})</span>` : ''}</div>${prIssues(p).length ? `<div class="plinks">${prIssues(p).filter(open).map(ilink).join('')}${prIssues(p).some(i => !open(i)) ? `<span class="muted small">+ ${prIssues(p).filter(i => !open(i)).length} closed</span>` : ''}</div>` : ''}</li>`; }).join('')}</ul>` : '<p class="muted">No open pull requests.</p>';
const deploysHtml = deploys.length ? `<ul class="plist">${deploys.map(d => `<li><div class="phead"><span class="pill pill-${d.state === 'success' ? 'done' : d.state === 'failure' || d.state === 'error' ? 'queued' : 'progress'}">${esc(d.state)}</span> <b>${esc(d.env)}</b> <a href="${esc(safeUrl(d.url))}">${esc(d.url.replace(/^https?:\/\//, ''))}</a></div><div class="muted small"><code>${esc(String(d.ref).slice(0, 40))}</code> · ${esc(day(d.at))}</div></li>`).join('')}</ul>` : '';
const openEpics = issues.filter(i => i.issue_type === 'epic' && open(i));
const epicsHtml = openEpics.map(e => {
  const kids = e.children; const done = kids.filter(k => k.status === 'closed').length;
  const seg = (k) => `<span class="seg seg-${k.lane}" title="${esc(shortId(k.id))} · ${esc(LANE_LABEL[k.lane])}"></span>`;
  return `<article class="epic"><div class="epic-head"><div><div class="muted small"><a href="#${anchor(e.id)}"><code>${esc(shortId(e.id))}</code></a> · ${prio(e)} ${pill(e.lane)}</div><h3><a href="#${anchor(e.id)}">${esc(e.title)}</a></h3></div><div class="big"><span>${done}</span><span class="of">/${kids.length}</span></div></div>
    ${kids.length ? `<div class="segs" role="img" aria-label="${done} of ${kids.length} children closed">${kids.map(seg).join('')}</div>
    <div class="scroll"><table><thead><tr><th>Child</th><th>Status</th><th>Task</th></tr></thead><tbody>${kids.map(k => `<tr><td><a href="#${anchor(k.id)}"><code>${esc(shortId(k.id))}</code></a></td><td>${pill(k.lane)}</td><td>${esc(k.title)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No children linked yet.</p>'}
  </article>`;
}).join('');
const readyNext = issues.filter(i => i.lane === 'ready').sort((a, b) => (a.priority - b.priority) || (level.get(a.id) - level.get(b.id))).slice(0, 6);

const diagram = orderSvg();
const generated = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const openIssues = buildOrder.filter(i => i.lane !== 'done');
const closedIssues = [...issues.filter(i => i.lane === 'done')].sort(closedDesc);
const RECENT_DAYS = 14;
const cutoff = days.length ? new Date(Date.parse(days[0].d) - RECENT_DAYS * 864e5).toISOString().slice(0, 10) : '';
const dayHtml = (g) => `<li><time>${esc(g.d)}</time><ul class="events">${g.items.map(e => `<li class="ev ev-${e.kind}">${e.html}</li>`).join('')}</ul></li>`;
const recentDays = days.filter(g => g.d >= cutoff), olderDays = days.filter(g => g.d < cutoff);
const noteCount = events.filter(e => e.kind === 'note').length;
const legacyCount = legacy.filter(e => e && e.at && e.note).length;

// ---- page -----------------------------------------------------------------
const THEME_LIGHT = `--ground:#f7f7f5; --panel:#efefec; --panel-2:#e6e6e2; --card:#ffffff; --line:#dcdcd7;
  --ink:#1c1d1f; --ink-2:#4f535a; --ink-3:#7d828a;
  --ok:#2e7d4f; --review:#3b5bdb; --progress:#a86b12; --queued:#8d9199; --deferred:#9a8c7a;
  --accent-ink:color-mix(in srgb, var(--accent) 88%, #000);`;
const THEME_DARK = `--ground:#141517; --panel:#1b1c1f; --panel-2:#232428; --card:#1e1f23; --line:#2f3136;
  --ink:#e8e9ec; --ink-2:#b3b7be; --ink-3:#80858e;
  --ok:#5cc28a; --review:#8ea4ff; --progress:#e0a64a; --queued:#6d717a; --deferred:#a8997f;
  --accent-ink:color-mix(in srgb, var(--accent) 62%, #fff);`;

const html = `<title>${esc(NAME)} Board</title>
<meta name="board-name" content="${esc(NAME)}">
<meta name="board-accent" content="${ACCENT}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">
<style>
:root{ --accent:${ACCENT}; ${THEME_LIGHT}
  --font:"Geist",system-ui,-apple-system,"Segoe UI",sans-serif; --mono:"Geist Mono",ui-monospace,Menlo,Consolas,monospace; color-scheme:light; }
@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){ ${THEME_DARK} color-scheme:dark; } }
:root[data-theme="dark"]{ ${THEME_DARK} color-scheme:dark; }
:root{ --accent-soft:color-mix(in srgb, var(--accent) 14%, var(--card)); --ok-soft:color-mix(in srgb, var(--ok) 14%, var(--card)); --review-soft:color-mix(in srgb, var(--review) 14%, var(--card)); --progress-soft:color-mix(in srgb, var(--progress) 16%, var(--card)); --queued-soft:color-mix(in srgb, var(--queued) 16%, var(--card)); --deferred-soft:color-mix(in srgb, var(--deferred) 16%, var(--card)); }
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--font);font-size:14px;line-height:1.5;padding-inline:16px}
a{color:var(--review)} a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
h1,h2,h3,h4,h5{margin:0;text-wrap:balance}
code{font-family:var(--mono);font-size:.92em}
pre{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px 12px;overflow-x:auto;font-size:12px}
.muted{color:var(--ink-3)} .small{font-size:12px}
.shell{display:grid;grid-template-columns:280px minmax(0,1fr);min-height:100vh;margin-inline:-16px}
.idx{position:sticky;top:0;height:100vh;overflow-y:auto;border-right:1px solid var(--line);background:var(--panel);padding:28px 18px 40px}
.idx h1{font-size:18px;font-weight:700;letter-spacing:-.01em;display:flex;align-items:center;gap:8px}
.idx h1::before{content:"";width:10px;height:10px;border-radius:3px;background:var(--accent);flex:none}
.idx .sub{color:var(--ink-3);font-size:12px;margin:4px 0 20px;overflow-wrap:anywhere}
.idx ol{list-style:none;padding:0;margin:0;display:grid;gap:2px}
.idx .sec>a{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:7px 10px;border-radius:6px;color:var(--ink);text-decoration:none;font-weight:500}
.idx a:hover{background:var(--panel-2)} .idx a.active{background:var(--panel-2)}
.idx .k{font-family:var(--mono);font-size:11px;color:var(--ink-3);white-space:nowrap;font-weight:400}
.idx ol.issues{margin:2px 0 6px 10px;padding-left:8px;border-left:1px solid var(--line);gap:0}
.idx ol.issues a{display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:baseline;padding:3px 8px;border-radius:5px;font-size:12px;color:var(--ink-2);text-decoration:none;border-left:2px solid transparent}
.idx ol.issues a .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.idx ol.issues a code{font-size:11px}
.idx li.lane-ready a code{color:var(--accent-ink)} .idx li.lane-progress a code{color:var(--progress)} .idx li.lane-review a code{color:var(--review)} .idx li.lane-queued a code,.idx li.lane-deferred a code{color:var(--ink-3)} .idx li.lane-done a{color:var(--ink-3)}
.idx details{margin:2px 0 0 10px;font-size:12px;color:var(--ink-3)} .idx summary{cursor:pointer;padding:3px 8px}
.idx .stat{margin-top:22px;padding-top:16px;border-top:1px solid var(--line);display:grid;gap:6px;font-size:12px;color:var(--ink-2)}
.idx .stat b{font-family:var(--mono);font-weight:500;color:var(--ink);font-variant-numeric:tabular-nums}
main{padding:40px 40px 120px;max-width:1400px;min-width:0}
.eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);margin-bottom:6px}
.view>h2{font-size:24px;font-weight:700;letter-spacing:-.01em;margin-bottom:6px}
.lead{color:var(--ink-2);max-width:66ch;margin:0 0 22px}
h3.sub{font-size:15px;font-weight:600;margin:34px 0 12px}
.summary{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:20px 0 8px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;border-top:3px solid var(--c,var(--line))}
.tile .n{font-family:var(--mono);font-size:26px;font-weight:500;font-variant-numeric:tabular-nums;line-height:1.1}
.tile .l{font-size:12px;color:var(--ink-2);margin-top:4px;font-weight:500} .tile .h{font-size:11px;color:var(--ink-3)}
.tile.ready{--c:var(--accent);background:var(--accent-soft)} .tile.ready .n{color:var(--accent-ink)}
.tile.queued{--c:var(--queued)} .tile.progress{--c:var(--progress)} .tile.review{--c:var(--review)} .tile.done{--c:var(--ok)} .tile.deferred{--c:var(--deferred)}
.twocol{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}
.plist{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.plist li{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;min-width:0;overflow-wrap:anywhere}
.phead{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:baseline;font-weight:500}
.plinks{display:grid;gap:2px;margin-top:6px;padding-top:6px;border-top:1px solid var(--line)}
.epic{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;display:grid;gap:12px;margin-bottom:12px;min-width:0}
.epic-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-end;flex-wrap:wrap}
.epic h3{font-size:16px;font-weight:600;line-height:1.3} .epic h3 a{color:inherit;text-decoration:none}
.big{font-family:var(--mono);font-size:34px;font-weight:500;line-height:1} .big .of{font-size:18px;color:var(--ink-3)}
.segs{display:flex;gap:3px;height:10px} .seg{flex:1;border-radius:3px;background:var(--queued)}
.seg-done{background:var(--ok)} .seg-ready{background:var(--accent)} .seg-progress{background:var(--progress)} .seg-review{background:var(--review)} .seg-deferred{background:repeating-linear-gradient(45deg,var(--deferred) 0 3px,transparent 3px 6px);border:1px solid var(--deferred)}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}
table{border-collapse:collapse;width:100%;font-size:13px}
th{text-align:left;font-weight:500;color:var(--ink-3);font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:6px 10px 6px 0;border-bottom:1px solid var(--line)}
td{padding:7px 10px 7px 0;border-bottom:1px solid var(--line);vertical-align:top}
td:last-child{min-width:200px}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 6px}
.tab{display:inline-flex;align-items:baseline;gap:8px;padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink);text-decoration:none;font-size:13px;font-weight:500}
.tab .k{font-family:var(--mono);font-size:11px;color:var(--ink-3)} .tab.active{background:var(--ink);color:var(--ground);border-color:var(--ink)} .tab.active .k{color:var(--ground);opacity:.75}
.ms{margin-top:20px}
.mshead{display:flex;align-items:center;gap:14px;margin-bottom:12px;flex-wrap:wrap}
.mshead h3{font-size:15px;font-weight:600} .mshead .n{font-family:var(--mono);font-size:12px;color:var(--ink-2)}
.bar{flex:1;max-width:220px;min-width:80px;height:6px;background:var(--panel-2);border-radius:3px;overflow:hidden;display:block} .bar span{display:block;height:100%;background:var(--ok)}
.board{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;align-items:start}
.colhead{display:flex;justify-content:space-between;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);padding:0 4px 8px;border-bottom:1px solid var(--line);margin-bottom:8px}
.colhead .n{font-family:var(--mono)}
.col{display:grid;gap:8px;min-width:0}
.empty{color:var(--ink-3);font-size:12px;padding:6px 4px}
.more{font-size:12px;padding:4px;text-decoration:none}
.deferred{margin-top:18px} .dgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}
.card{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--queued);border-radius:6px;padding:10px 12px 10px 11px;min-width:0}
.card.lane-ready{border-left-color:var(--accent)} .card.lane-progress{border-left-color:var(--progress)} .card.lane-review{border-left-color:var(--review)} .card.lane-done{border-left-color:var(--ok);opacity:.85} .card.lane-deferred{border-left-color:var(--deferred);border-left-style:dashed}
.card header{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}
.card h4{font-size:13px;font-weight:600;line-height:1.35;overflow-wrap:anywhere} .card h4 a{color:inherit;text-decoration:none}
.card p{margin:6px 0 0;font-size:12px;color:var(--ink-2);line-height:1.45;overflow-wrap:anywhere}
.card footer{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:8px;font-size:11px;color:var(--ink-3)} .card footer a{color:var(--ink-2)}
.type{font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3)}
.id{font-family:var(--mono);font-size:11px;color:var(--ink-2);text-decoration:none}
.owner{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--progress)}
.prio{font-family:var(--mono);font-size:10px;font-weight:500;padding:1px 6px;border-radius:4px;background:var(--panel-2);color:var(--ink-2)}
.prio.P0{background:var(--accent-soft);color:var(--accent-ink)} .prio.P1{color:var(--ink)}
.pr{font-size:11px;font-weight:500;text-decoration:none;padding:1px 6px;border-radius:4px;background:var(--review-soft);color:var(--review);white-space:nowrap}
.pill{font-size:10px;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;border-radius:99px;background:var(--queued-soft);color:var(--ink-2);white-space:nowrap}
.pill-ready{background:var(--accent-soft);color:var(--accent-ink)} .pill-progress{background:var(--progress-soft);color:var(--progress)} .pill-review{background:var(--review-soft);color:var(--review)} .pill-done{background:var(--ok-soft);color:var(--ok)} .pill-deferred{background:var(--deferred-soft);color:var(--deferred)}
.order{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:10px;max-width:100%}
.order svg{display:block;max-width:none}
.edge{fill:none;stroke-width:1.3}
.edge-block{stroke:var(--ink-3);opacity:.75} .edge-done{stroke:var(--ok);opacity:.6}
.edge-child{stroke:var(--ink-3);stroke-dasharray:4 4;opacity:.55}
.head{fill:var(--ink-3)} .head-done{fill:var(--ok)}
.node rect{fill:var(--card);stroke:var(--line);stroke-width:1.2}
a:hover .node rect{stroke:var(--accent);stroke-width:2}
.node.lane-ready rect{stroke:var(--accent);stroke-width:1.8} .node.lane-done rect{stroke:var(--ok)} .node.lane-review rect{stroke:var(--review);stroke-width:1.8} .node.lane-progress rect{stroke:var(--progress);stroke-width:1.8} .node.lane-deferred rect{stroke:var(--deferred);stroke-dasharray:4 3}
.node.lane-done .ntitle{fill:var(--ink-3)}
.nid{font-family:var(--mono);font-size:10px;fill:var(--ink-3)} .ntitle{font-family:var(--font);font-size:12px;font-weight:500;fill:var(--ink)}
.legend{display:flex;flex-wrap:wrap;gap:8px 16px;margin:10px 0 18px;font-size:12px;color:var(--ink-2)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{width:12px;height:10px;border-radius:2px;border:2px solid var(--c);background:var(--card)} .ln{width:22px;border-top:2px solid var(--ink-3)} .ln.d{border-top-style:dashed} .ln.g{border-top-color:var(--ok)}
.irows{display:grid;border-top:1px solid var(--line)}
.irow{display:grid;grid-template-columns:30px 34px 70px minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 6px 8px 9px;border-bottom:1px solid var(--line);color:var(--ink);text-decoration:none;font-size:13px;border-left:3px solid var(--queued)}
.irow:hover{background:var(--panel)} .irow .n{font-family:var(--mono);font-size:11px;color:var(--ink-3)} .irow code{color:var(--ink-3);font-size:11px;overflow:hidden;text-overflow:ellipsis}
.irow .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.irow.lane-ready{border-left-color:var(--accent)} .irow.lane-progress{border-left-color:var(--progress)} .irow.lane-review{border-left-color:var(--review)} .irow.lane-done{border-left-color:var(--ok);color:var(--ink-3)} .irow.lane-deferred{border-left-color:var(--deferred)}
.issue{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:18px 22px 14px;border-top:3px solid var(--queued);min-width:0}
.issue.lane-ready{border-top-color:var(--accent)} .issue.lane-progress{border-top-color:var(--progress)} .issue.lane-review{border-top-color:var(--review)} .issue.lane-done{border-top-color:var(--ok)} .issue.lane-deferred{border-top-color:var(--deferred)}
.ihead{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px;font-size:12px} .ihead .n{font-family:var(--mono);color:var(--ink-3)}
.issue h3{font-size:18px;font-weight:650;line-height:1.3}
.igrid{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:14px 28px;margin-top:14px}
.imain{min-width:0;max-width:74ch;overflow-wrap:anywhere} .iside{border-left:1px solid var(--line);padding-left:20px;min-width:0;overflow-wrap:anywhere}
.field{margin-bottom:14px} .flabel{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);margin-bottom:4px}
.fbody p{margin:0 0 8px} .fbody ul,.fbody ol{margin:0 0 8px;padding-left:20px} .fbody h5{margin:10px 0 4px;font-size:13px}
.comment{border-left:2px solid var(--line);padding-left:10px;margin-bottom:10px}
.ilink{display:inline-flex;gap:6px;align-items:baseline;color:var(--ink);text-decoration:none;font-size:12px;line-height:1.6;min-width:0;max-width:100%}
.ilink code{color:var(--ink-3);flex:none;white-space:nowrap} .ilink:hover{color:var(--accent-ink)} .ilink.closed{color:var(--ink-3)}
.kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;margin:0;font-size:12px} .kv dt{color:var(--ink-3)} .kv dd{margin:0;font-family:var(--mono);overflow-wrap:anywhere}
.ifoot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:14px;padding-top:10px;border-top:1px solid var(--line);font-size:12px} .ifoot a{color:var(--ink-2);text-decoration:none}
.log{list-style:none;padding:0;margin:0;border-top:1px solid var(--line)}
.log>li{display:grid;grid-template-columns:110px minmax(0,1fr);gap:16px;padding:12px 0;border-bottom:1px solid var(--line)}
.log time{font-family:var(--mono);font-size:12px;color:var(--ink-3)}
.events{list-style:none;margin:0;padding:0;display:grid;gap:4px;min-width:0}
.ev{font-size:13px;color:var(--ink-2);overflow-wrap:anywhere;padding-left:14px;position:relative}
.ev::before{content:"";position:absolute;left:0;top:.6em;width:6px;height:6px;border-radius:50%;background:var(--queued)}
.ev-closed::before{background:var(--ok)} .ev-merged::before{background:var(--review)} .ev-pr::before{background:var(--review);opacity:.5}
.ev-note{background:var(--accent-soft);border-radius:6px;padding:8px 10px 8px 14px;color:var(--ink)} .ev-note::before{background:var(--accent);top:1.05em;left:4px}
.note-on{font-size:12px;color:var(--ink-2);margin-bottom:4px} .note-body p{margin:0 0 6px} .note-body p:last-child{margin:0}
details.older{margin-top:16px} details.older>summary{cursor:pointer;color:var(--ink-2);padding:8px 0}
.foot{margin-top:56px;color:var(--ink-3);font-size:12px;overflow-wrap:anywhere}
@media (max-width:1100px){.board{grid-template-columns:repeat(3,minmax(0,1fr))}.summary{grid-template-columns:repeat(3,minmax(0,1fr))}.igrid,.twocol{grid-template-columns:1fr}.iside{border-left:0;padding-left:0;border-top:1px solid var(--line);padding-top:12px}}
@media (max-width:900px){
  .shell{grid-template-columns:1fr}
  .idx{position:sticky;top:0;z-index:5;height:auto;padding:10px 16px;border-right:0;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px;overflow-x:auto}
  .idx h1{font-size:14px;white-space:nowrap} .idx .sub,.idx .stat,.idx ol.issues,.idx details{display:none}
  .idx>ol{display:flex;gap:4px} .idx .sec>a{white-space:nowrap;padding:6px 10px}
  main{padding:24px 16px 80px}
}
@media (max-width:640px){.board,.summary{grid-template-columns:1fr 1fr}.log>li{grid-template-columns:1fr;gap:4px}.irow{grid-template-columns:30px 34px minmax(0,1fr)}.irow code,.irow .pill{display:none}.issue{padding:14px}}
@media (max-width:420px){.board{grid-template-columns:1fr}}
@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}}
</style>
<div class="shell">
  <nav class="idx" aria-label="Sections">
    <h1>${esc(NAME)} Board</h1>
    <div class="sub">${esc(ownerRepo || basename(REPO))}${branch ? ` · <code>${esc(branch)}</code>` : ''}</div>
    <ol>
      <li class="sec"><a href="#status"><span>Status</span><span class="k">${issues.length}</span></a></li>
      <li class="sec"><a href="#board"><span>Board</span><span class="k">${usesMilestones ? `${milestones.length} milestones` : `${openIssues.length} open`}</span></a>
        ${usesMilestones ? `<ol class="issues">${milestones.map(ms => `<li><a href="#board-${slug(ms)}"><code>ms</code><span class="t">${esc(ms)}</span></a></li>`).join('')}</ol>` : ''}</li>
      <li class="sec"><a href="#issues"><span>Issues &amp; build order</span><span class="k">${openIssues.length} open</span></a>
        <ol class="issues">${openIssues.map(i => `<li class="lane-${i.lane}"><a href="#${anchor(i.id)}"><code>${esc(shortId(i.id))}</code><span class="t">${esc(i.title)}</span></a></li>`).join('')}</ol>
        ${closedIssues.length ? `<details><summary>${closedIssues.length} closed</summary><ol class="issues">${closedIssues.map(i => `<li class="lane-done"><a href="#${anchor(i.id)}"><code>${esc(shortId(i.id))}</code><span class="t">${esc(i.title)}</span></a></li>`).join('')}</ol></details>` : ''}</li>
      <li class="sec"><a href="#log"><span>Check-ins</span><span class="k">${days.length} days</span></a></li>
      <li class="sec"><a href="#done"><span>Done</span><span class="k">${closedIssues.length}</span></a></li>
    </ol>
    <div class="stat">
      <div>Ready now <b>${counts.ready}</b></div><div>In progress <b>${counts.progress}</b></div><div>In review <b>${counts.review}</b></div>
      <div>Done <b>${counts.done}</b> of <b>${issues.length}</b></div><div>Generated <b>${generated}</b></div>
    </div>
  </nav>
  <main>
    <section id="view-status" class="view">
      <div class="eyebrow">Beads${prefix ? ` · prefix ${esc(prefix)}` : ''} · ${issues.length} issues</div>
      <h2>Where the build stands</h2>
      <p class="lead">One card per beads issue. A card moves right as it is claimed, opened as a pull request and closed. Every id opens that issue's full record.</p>
      <div class="summary">${[...LANES, ['deferred', 'Deferred', 'parked on purpose']].map(([k, l, h]) => `<div class="tile ${k}"><div class="n">${counts[k]}</div><div class="l">${l}</div><div class="h">${h}</div></div>`).join('')}</div>
      <div class="twocol">
        <div><h3 class="sub">Open pull requests</h3>${prsHtml}</div>
        <div><h3 class="sub">Ready next</h3>${readyNext.length ? `<ul class="plist">${readyNext.map(i => `<li>${prio(i)} ${ilink(i)}</li>`).join('')}</ul>` : '<p class="muted">Nothing ready: everything open is claimed, queued or deferred.</p>'}</div>
      </div>
      ${deploysHtml ? `<h3 class="sub">Deploys (last 30 days, latest per environment)</h3>${deploysHtml}` : ''}
      ${openEpics.length ? `<h3 class="sub">Epics</h3>${epicsHtml}` : ''}
    </section>
    <section id="view-board" class="view" hidden>
      <h2>Board</h2>
      <p class="lead">${usesMilestones ? 'One board per milestone. ' : ''}Queued cards wait on the issues named in their footer. Done shows the most recent ${DONE_ON_BOARD}; the rest are in the done archive.</p>
      ${usesMilestones ? `<div class="tabs" role="tablist" aria-label="Milestones">${milestones.map(ms => { const it = issues.filter(i => msName(i) === ms && i.lane !== 'deferred'); return `<a role="tab" class="tab" data-ms="${slug(ms)}" href="#board-${slug(ms)}">${esc(ms)} <span class="k">${it.filter(i => i.lane === 'done').length}/${it.length}</span></a>`; }).join('')}</div>` : ''}
      <div id="boards">${milestones.map(milestoneBoard).join('')}</div>
    </section>
    <section id="view-issues" class="view" hidden>
      <div id="issues-list">
        <h2>Issues and build order</h2>
        <p class="lead">Work flows left to right: an issue sits one column right of its deepest blocker or parent, and becomes ready when every solid arrow into it comes from a done box.${SMALL ? '' : ' Large project: the diagram shows each group that still has open work.'} Scroll the diagram sideways.</p>
        ${diagram.count ? `<div class="order">${diagram.svg}</div>` : '<p class="muted">No issues to draw.</p>'}
        <div class="legend"><span><i class="sw" style="--c:var(--accent)"></i>ready</span><span><i class="sw" style="--c:var(--progress)"></i>in progress</span><span><i class="sw" style="--c:var(--review)"></i>in review</span><span><i class="sw" style="--c:var(--ok)"></i>done</span><span><i class="sw" style="--c:var(--queued)"></i>queued</span><span><i class="ln"></i>blocks</span><span><i class="ln g"></i>blocker done</span><span><i class="ln d"></i>parent → child</span></div>
        <div class="irows">${openIssues.map((i, n) => irow(i, n + 1)).join('')}</div>
      </div>
      <div class="issues-detail">${buildOrder.map((i, n) => issueDetail(i, n + 1)).join('')}</div>
    </section>
    <section id="view-log" class="view" hidden>
      <h2>Check-ins</h2>
      <p class="lead">Built from what beads and GitHub recorded: issues opened and closed, pull requests opened and merged. Highlighted lines are notes: beads comments${legacyCount ? `, plus ${legacyCount} from an earlier hand-kept log` : ''}.</p>
      <ul class="log">${recentDays.map(dayHtml).join('') || '<li><time>—</time><div class="muted">Nothing recorded yet.</div></li>'}</ul>
      ${olderDays.length ? `<details class="older"><summary>${olderDays.length} earlier days</summary><ul class="log">${olderDays.map(dayHtml).join('')}</ul></details>` : ''}
    </section>
    <section id="view-done" class="view" hidden>
      <h2>Done</h2>
      <p class="lead">Every closed issue, newest first.</p>
      <div class="scroll"><table><thead><tr><th>Closed</th><th>Id</th><th>P</th><th>PR</th><th>Title</th></tr></thead><tbody>${closedIssues.map(i => `<tr><td class="muted">${esc(day(i.closed_at))}</td><td><a href="#${anchor(i.id)}"><code>${esc(shortId(i.id))}</code></a></td><td>${prio(i)}</td><td>${prTag(i.pr)}</td><td>${esc(i.title)}</td></tr>`).join('')}</tbody></table></div>
    </section>
    <p class="foot">${repoUrl ? `<a href="${esc(repoUrl)}">${esc(ownerRepo)}</a> · ` : ''}Generated ${generated} from <code>bd export</code> and <code>gh</code> by the braynee board skill.</p>
  </main>
</div>
<script>
(function () {
  var views = [].slice.call(document.querySelectorAll('.view'));
  var list = document.getElementById('issues-list');
  var articles = [].slice.call(document.querySelectorAll('.issue'));
  var links = [].slice.call(document.querySelectorAll('.idx a'));
  var boards = [].slice.call(document.querySelectorAll('#boards .ms'));
  var tabs = [].slice.call(document.querySelectorAll('.tabs .tab'));
  var firstMs = boards.length ? boards[0].getAttribute('data-ms') : '';
  var title = ${JSON.stringify(NAME + ' Board')};
  function route() {
    var h = decodeURIComponent((location.hash || '#status').slice(1));
    var issue = h.indexOf('issue-') === 0 && document.getElementById(h) ? h : null;
    var ms = h.indexOf('board-') === 0 ? h.slice(6) : (h === 'board' ? firstMs : null);
    var view = issue ? 'issues' : (ms !== null ? 'board' : h);
    // Views carry a "view-" id so the hash never triggers the browser's own anchor jump.
    if (!document.getElementById('view-' + view)) { view = 'status'; issue = null; ms = null; }
    views.forEach(function (v) { v.hidden = v.id !== 'view-' + view; });
    list.hidden = !!issue;
    articles.forEach(function (a) { a.hidden = a.id !== issue; });
    if (ms !== null) {
      if (!boards.some(function (b) { return b.getAttribute('data-ms') === ms; })) ms = firstMs;
      boards.forEach(function (b) { b.hidden = b.getAttribute('data-ms') !== ms; });
      tabs.forEach(function (t) { var on = t.getAttribute('data-ms') === ms; t.classList.toggle('active', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); });
    }
    links.forEach(function (a) {
      var href = a.getAttribute('href');
      var top = !a.closest('.issues');
      var on = href === '#' + h || (top && href === '#' + view) || (ms !== null && href === '#board-' + ms);
      a.classList.toggle('active', on);
    });
    window.scrollTo(0, 0);
    setTimeout(function () { window.scrollTo(0, 0); }, 0);
    document.title = (issue ? issue.replace('issue-', '') + ' · ' : '') + title;
  }
  window.addEventListener('hashchange', route);
  route();
})();
</script>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(JSON.stringify({ out: OUT, name: NAME, accent: ACCENT, issues: issues.length, prs: prs.length, deploys: deploys.length, milestones: usesMilestones ? milestones : [], diagramNodes: diagram.count, checkinDays: days.length, notes: noteCount, lanes: counts, bytes: Buffer.byteLength(html) }));
