#!/usr/bin/env node
// statusline.js — braynee's Claude Code status line renderer.
//
// This is the SHIPPED renderer. /setup copies it to a stable path
// (~/.claude/statusline.js) and points settings.json `statusLine.command` at
// that copy — NOT at this versioned plugin path, which changes on every plugin
// update. Registering a status line is not expressible in hooks.json, so setup
// writes the `statusLine` settings key (camelCase, object-valued).
//
// Reads two inputs and degrades gracefully if either is absent:
//   • Claude Code's status JSON on stdin (model, context, cost, worktree, …)
//   • braynee's live state at ~/.claude/statusline-live.json (goal, timer,
//     beads) written by statusline-state.js + session-auto-track.js, and
//     ~/.claude/beads-active-issue.json written by the beads claim hook.
//
// Line 1 (WHAT):  🎯 session goal  │  ⏱ active timer task (Xm)  │  📋 beads  │  [session-name]
// Line 2 (WHERE): [Model] 🧠 medium │ 📁 folder │ 🌿 branch [wt:name] │ 🔗 repo │ 🤖 agent
// Line 3 (COST):  ▓▓░░ 42% │ 💰 $0.56 │ ⏱️ 1h4m (12m API)
// Line 4 (USAGE): 🔤 3.3k↓ 1.7k↑ 💾cache │ 5h:23% 7d:41%

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Git Cache (keyed by session_id to prevent cross-session collisions) ─────
const GIT_CACHE_MAX_AGE = 5; // seconds

function getCachedGit(cwd, sessionId) {
  const cacheFile = path.join(os.tmpdir(), `claude-statusline-git-${sessionId}`);
  try {
    const stat = fs.statSync(cacheFile);
    if ((Date.now() - stat.mtimeMs) / 1000 <= GIT_CACHE_MAX_AGE) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached.cwd === cwd) return cached;
    }
  } catch { /* no usable cache — fall through and recompute */ }

  // Branch only. The repo URL now comes from Claude Code's provided
  // workspace.repo (parsed from origin) — no `git remote` subprocess, which
  // was fragile when cwd wasn't a clean native path. See cp-bw8.
  const result = { cwd, branch: '' };
  try {
    execSync('git rev-parse --git-dir', { cwd, stdio: 'ignore', windowsHide: true });
    result.branch = execSync('git branch --show-current', {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
  } catch { /* not a git repo, or git missing — render with an empty branch */ }

  try { fs.writeFileSync(cacheFile, JSON.stringify(result)); } catch { /* perf cache only; the statusline renders on every keystroke, so logging a persistently unwritable cache here would flood the log */ }
  return result;
}

// ─── Context Window persistence (for the context-budget-warn hook) ───────────
// The UserPromptSubmit hook can't reliably detect the context window size from
// the transcript (the model is recorded as e.g. "claude-opus-4-7" with no
// "[1m]" suffix, and the "context-1m" beta marker is absent), so it would
// default to a 200k window and warn far too early on 1M-window models. Claude
// Code gives the statusline the authoritative size + used%, so we persist them
// here (keyed by session) for the hook to consume. See cp-e0i / cp-sat.
function persistContextWindow(sessionId, size, usedPct, exceeds200k) {
  if (!sessionId || !(size > 0)) return;
  try {
    const dir = path.join(os.homedir(), '.cache', 'braynee');
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ size, usedPct, exceeds200k, ts: Date.now() });
    fs.writeFileSync(path.join(dir, `context-window-${String(sessionId).slice(0, 12)}.json`), payload);
    // cp-03z: also persist a machine-level "latest known window" snapshot. The
    // per-session file is missing right after a (re)started session_id, and the
    // warn hook fires on UserPromptSubmit before the statusline re-renders for
    // the new id — so it needs a session-independent fallback. Window SIZE is a
    // stable property of the model/plan, so the most-recent value is a safe
    // default until this session's own file appears.
    fs.writeFileSync(path.join(dir, 'context-window-latest.json'), payload);
  } catch (e) {
    // Non-fatal — the statusline must never throw. But context-budget-warn reads
    // this file for the window size, so a failing write silently disables context
    // warnings in a way nothing else reports (cp-ccsh.11). Required lazily and
    // guarded: the statusline renders constantly and must not gain a hard dep.
    try {
      require(path.join(__dirname, 'lib', 'hook-logger.js'))
        .debug('statusline', `could not persist context-window state: ${e && e.message}`);
    } catch { /* statusline must never throw */ }
  }
}

// ─── Live State (written by statusline-state.js async hook) ──────────────────
function getLiveState(currentDir) {
  const STATE_FILE = path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'statusline-live.json');
  try {
    const stat = fs.statSync(STATE_FILE);
    if ((Date.now() - stat.mtimeMs) / 1000 > 300) return {};
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (state.cwd && !currentDir.toLowerCase().startsWith(state.cwd.toLowerCase()) &&
        !state.cwd.toLowerCase().startsWith(currentDir.toLowerCase())) {
      return {};
    }
    return state;
  } catch {
    return {};
  }
}

// ─── Active Beads Issue ───────────────────────────────────────────────────────
function getActiveBeadsIssue(currentDir) {
  const file = path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'beads-active-issue.json');
  try {
    const stat = fs.statSync(file);
    if ((Date.now() - stat.mtimeMs) / 1000 > 3600) return null; // stale after 1h
    const issue = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Only show if the active issue belongs to this session's project
    if (issue.project && currentDir) {
      const currentFolder = path.basename(currentDir).toLowerCase();
      const issueProject = issue.project.toLowerCase();
      if (currentFolder !== issueProject) return null;
    }
    return issue;
  } catch {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

function formatK(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max - 1) + '…' : str;
}

const osc8 = (url, text) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

// ─── Main ─────────────────────────────────────────────────────────────────────
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(input); } catch { process.exit(0); }

  // Colors
  const PINK     = '\x1b[38;5;213m';
  const HOT_PINK = '\x1b[38;5;199m';
  const CYAN     = '\x1b[36m';
  const GREEN    = '\x1b[32m';
  const YELLOW   = '\x1b[33m';
  const RED      = '\x1b[31m';
  const DIM      = '\x1b[2m';
  const BOLD     = '\x1b[1m';
  const RESET    = '\x1b[0m';
  const SEP      = `${PINK}│${RESET}`;

  // ── Core fields ──────────────────────────────────────────────────
  const sessionId   = data.session_id || 'default';
  const sessionName = data.session_name || '';
  const model       = data.model?.display_name || '';
  const currentDir  = data.workspace?.current_dir || data.cwd || '';
  const projectDir  = data.workspace?.project_dir || '';
  // Use data.workspace.added_dirs directly (provided by Claude Code)
  const addedDirs   = (data.workspace?.added_dirs || []).map(d =>
    path.basename(d.replace(/\\/g, '/').replace(/\/$/, ''))
  );

  // ── Context window ───────────────────────────────────────────────
  const pct         = Math.floor(data.context_window?.used_percentage || 0);
  const exceeds200k = data.exceeds_200k_tokens || false;
  // Use current_usage for accurate per-call counts; fall back to cumulative totals
  const curUsage    = data.context_window?.current_usage;
  const inputTok    = curUsage
    ? (curUsage.input_tokens || 0) + (curUsage.cache_creation_input_tokens || 0) + (curUsage.cache_read_input_tokens || 0)
    : (data.context_window?.total_input_tokens || 0);
  const outputTok   = curUsage
    ? (curUsage.output_tokens || 0)
    : (data.context_window?.total_output_tokens || 0);
  const cacheHits   = curUsage?.cache_read_input_tokens || 0;

  // ── Cost / timing ────────────────────────────────────────────────
  const cost       = data.cost?.total_cost_usd || 0;
  const durationMs = data.cost?.total_duration_ms || 0;
  const apiMs      = data.cost?.total_api_duration_ms || 0;

  // ── Rate limits (Pro/Max only — absent for other plans) ──────────
  const rl5h = data.rate_limits?.five_hour?.used_percentage;
  const rl7d = data.rate_limits?.seven_day?.used_percentage;

  // ── Reasoning ────────────────────────────────────────────────────
  const effort   = data.effort?.level || '';
  const thinking = data.thinking?.enabled || false;

  // ── Agent ────────────────────────────────────────────────────────
  const agentName = data.agent?.name || '';

  // ── Worktree ──────────────────────────────────────────────────────
  const worktree = data.worktree || null;

  // ── Repo (provided by Claude Code, parsed from origin) ───────────
  const repo = data.workspace?.repo || null;

  // ── Open PR for the current branch (absent until found / after merge) ─
  const pr = data.pr || null;

  // ── Context window size (200000, or 1000000 for extended models) ──
  const winSize = data.context_window?.context_window_size || 0;
  const winLabel = winSize >= 1_000_000 ? '1M'
    : winSize >= 1000 ? `${Math.round(winSize / 1000)}k` : '';

  // Persist authoritative window size + used% for the context-budget-warn hook.
  persistContextWindow(sessionId, winSize, pct, exceeds200k);

  const live = getLiveState(currentDir);
  const git  = getCachedGit(currentDir, sessionId);

  // ── Line 1: WHAT ─────────────────────────────────────────────────
  const goalStr = live.goal ? `${BOLD}🎯 ${truncate(live.goal, 68)}${RESET}` : '';
  let timerStr = '';
  if (live.activeTimer?.title) {
    const elapsed = live.activeTimer.elapsedMinutes;
    const elapsedStr = elapsed > 0 ? ` ${DIM}(${elapsed}m)${RESET}` : '';
    timerStr = `${YELLOW}⏱${RESET} ${truncate(live.activeTimer.title, 40)}${elapsedStr}`;
  }
  let beadsStr = '';
  const activeIssue = getActiveBeadsIssue(currentDir);
  if (activeIssue?.id) {
    const label = activeIssue.mtnTitle || activeIssue.title || activeIssue.id;
    beadsStr = `${CYAN}📋 ${DIM}${activeIssue.id}${RESET} ${CYAN}${truncate(label, 40)}${RESET}`;
  } else if (live.beads?.openCount != null) {
    beadsStr = `${CYAN}📋 ${live.beads.openCount} open${RESET}`;
  }
  const nameStr = sessionName ? `${DIM}[${sessionName}]${RESET}` : '';

  const line1Parts = [goalStr, timerStr, beadsStr, nameStr].filter(Boolean);
  const line1 = line1Parts.join(`  ${SEP}  `);

  // ── Line 2: WHERE ────────────────────────────────────────────────
  // Model + reasoning indicators (effort + thinking)
  let modelStr = `${HOT_PINK}[${model}]${RESET}`;
  if (effort || thinking) {
    const icon = thinking ? '🧠' : '💭';
    const effortColor = (effort === 'max' || effort === 'xhigh') ? RED : effort === 'high' ? YELLOW : DIM;
    const color = thinking && !effort ? CYAN : effortColor;
    modelStr += ` ${color}${icon}${effort ? ' ' + effort : ''}${RESET}`;
  }

  // Directory: show root → subdir if cd'd into a subdirectory
  const baseDir = path.basename(currentDir);
  const rootDir = projectDir ? path.basename(projectDir) : baseDir;
  let dirDisplay = projectDir && currentDir !== projectDir
    ? `📁 ${rootDir} ${DIM}→${RESET} ${baseDir}`
    : `📁 ${baseDir}`;
  if (addedDirs.length) {
    dirDisplay += ' ' + addedDirs.map(d => `${DIM}+${d}${RESET}`).join(' ');
  }

  // Worktree branch takes precedence over cached git branch
  const branch = worktree?.branch || git.branch;
  const worktreePart = worktree?.name ? `${DIM}[wt:${worktree.name}]${RESET}` : '';
  const gitPart = branch ? `🌿 ${branch}${worktreePart ? ' ' + worktreePart : ''}` : '';

  // Repo link from the provided workspace.repo (no git subprocess).
  let repoPart = '';
  if (repo?.host && repo?.owner && repo?.name) {
    const repoUrl = `https://${repo.host}/${repo.owner}/${repo.name}`;
    repoPart = `${CYAN}🔗 ${osc8(repoUrl, repo.name)}${RESET}`;
  }

  // PR badge: number + review-state icon, clickable when a URL is present.
  let prPart = '';
  if (pr?.number) {
    const rs = pr.review_state;
    const icon = rs === 'approved' ? '✓' : rs === 'changes_requested' ? '✗'
      : rs === 'draft' ? '◌' : '◍';
    const rc = rs === 'approved' ? GREEN : rs === 'changes_requested' ? RED : YELLOW;
    const label = `🔀 #${pr.number} ${rc}${icon}${RESET}`;
    prPart = `${CYAN}${pr.url ? osc8(pr.url, label) : label}${RESET}`;
  }

  const agentPart = agentName ? `${CYAN}🤖 ${agentName}${RESET}` : '';

  const line2Parts = [
    modelStr,
    `${PINK}${dirDisplay}${RESET}`,
    gitPart ? `${PINK}${gitPart}${RESET}` : '',
    repoPart,
    prPart,
    agentPart,
  ].filter(Boolean);
  const line2 = line2Parts.join(` ${SEP} `);

  // ── Line 3: METRICS ──────────────────────────────────────────────
  const filled = Math.floor(pct / 10);
  // Thresholds match the context-budget hook: yellow at 60% (the /compact
  // nudge point), red at 85%+ or once the 200k cliff is exceeded.
  let barColor = GREEN;
  if (pct >= 85 || exceeds200k) barColor = RED;
  else if (pct >= 60) barColor = YELLOW;
  const bar    = barColor + '▓'.repeat(filled) + DIM + '░'.repeat(10 - filled) + RESET;
  const winStr = winLabel ? `${DIM}·${winLabel}${RESET}` : '';
  const pctStr = (exceeds200k ? `${RED}${pct}%!${RESET}` : `${pct}%`) + winStr;

  // Token display with optional cache-hit indicator
  const cacheStr = cacheHits > 0 ? ` ${DIM}💾${formatK(cacheHits)}${RESET}` : '';
  const tokStr   = `${PINK}🔤 ${formatK(inputTok)}↓ ${formatK(outputTok)}↑${cacheStr}${RESET}`;

  // Rate limits — only shown when available (Pro/Max after first API response)
  let rateLimitStr = '';
  if (rl5h != null || rl7d != null) {
    const parts = [];
    if (rl5h != null) {
      const c = rl5h >= 90 ? RED : rl5h >= 70 ? YELLOW : DIM;
      parts.push(`${c}5h:${Math.round(rl5h)}%${RESET}`);
    }
    if (rl7d != null) {
      const c = rl7d >= 90 ? RED : rl7d >= 70 ? YELLOW : DIM;
      parts.push(`${c}7d:${Math.round(rl7d)}%${RESET}`);
    }
    rateLimitStr = parts.join(' ');
  }

  const line3Parts = [
    `${bar} ${pctStr}`,
    `${PINK}💰 $${cost.toFixed(2)}${RESET}`,
    `${PINK}⏱️ ${formatDuration(durationMs)}${RESET} ${DIM}(${formatDuration(apiMs)} API)${RESET}`,
  ].filter(Boolean);
  const line3 = line3Parts.join(` ${SEP} `);

  const line4Parts = [
    tokStr,
    rateLimitStr,
  ].filter(Boolean);
  const line4 = line4Parts.join(` ${SEP} `);

  const lines = [line1, line2, line3, line4].filter(Boolean);
  console.log(lines.join('\n'));
});
