// context-budget-warn.js
// Hook: UserPromptSubmit — warns when the session's context window crosses a
// configurable threshold, so you can /compact proactively instead of waiting
// for Claude Code's native (~78%, non-configurable) auto-compact. See cp-sat.
//
// Claude Code does NOT expose a context-% to hooks and no hook can force a
// /compact (verified: hooks.md + GH #18264/#25689/#46695). BUT the session
// transcript records exact token usage per turn (message.usage), and a hook
// receives transcript_path on stdin — so we compute the % ourselves from the
// latest usage block and emit a nudge. Cannot auto-compact; it prompts you.
//
// stdout text from a UserPromptSubmit hook is injected into context (same
// mechanism as memory-reminder.js), so both you and Claude see the warning.
//
// De-duped per session by tier (default 60/75/90) so it nudges once per tier,
// not on every prompt. Exits 0 silently on any error — never blocks a prompt.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_THRESHOLD_PCT = 60;

function controlDir() {
  const dir = path.join(os.homedir(), '.cache', 'braynee');
  try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch { return os.tmpdir(); }
}

function thresholdPct() {
  const raw = process.env.BRAYNEE_CONTEXT_WARN_PCT;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 && n < 100 ? n : DEFAULT_THRESHOLD_PCT;
}

// Model context window in tokens, in priority order:
//   1. BRAYNEE_CONTEXT_WINDOW_TOKENS env override (explicit escape hatch).
//   2. The authoritative size Claude Code hands the statusline, persisted to
//      ~/.cache/braynee/context-window-<sid>.json (see statusline.js / cp-e0i).
//      This is the ONLY reliable 1M-window signal: the transcript records the
//      model as e.g. "claude-opus-4-7" with no "[1m]" suffix and omits the
//      `context-1m` beta marker, so the heuristic below silently defaults to
//      200k and warns at ~12% of a real 1M window.
//   3. Transcript heuristic (has1m marker / loaded>200k / "[1m]" in model).
function windowTokens(model, has1m, loaded, persistedSize) {
  const env = Number(process.env.BRAYNEE_CONTEXT_WINDOW_TOKENS);
  if (Number.isFinite(env) && env > 0) return env;
  if (Number.isFinite(persistedSize) && persistedSize > 0) return persistedSize;
  if (has1m || (loaded || 0) > 200_000 || (model && /\[1m\]/i.test(model))) return 1_000_000;
  return 200_000;
}

// The window size + used% Claude Code last reported to the statusline for this
// session. Fresh-only (statusline re-renders constantly); ignore if stale.
function readPersistedContext(sessionId) {
  try {
    const file = path.join(controlDir(), `context-window-${String(sessionId || '').slice(0, 12)}.json`);
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!o || !(o.size > 0)) return null;
    if (Date.now() - (o.ts || 0) > 600_000) return null; // >10 min = stale
    return o;
  } catch { return null; }
}

// Latest usage block + model from the transcript. "Loaded context" = the input
// side (input + cache read + cache creation); output_tokens are the reply, not
// part of the carried context.
function readUsage(transcriptPath) {
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  let usage = null;
  let model = '';
  let has1m = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!has1m && /context-1m/i.test(line)) has1m = true; // 1M-context beta marker
    try {
      const e = JSON.parse(line);
      const m = e.message;
      if (!m) continue;
      if (m.model) model = m.model;
      if (m.usage) usage = m.usage;
    } catch { /* skip */ }
  }
  if (!usage) return null;
  const loaded =
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
  return { loaded, model, has1m };
}

function tiersFor(threshold) {
  return [...new Set([threshold, 75, 90])].filter(t => t >= threshold).sort((a, b) => a - b);
}

function stampFile(sessionId) {
  return path.join(controlDir(), `.context-warn-${(sessionId || 'nosid').slice(0, 12)}.json`);
}
function lastTier(file) {
  try { return Number(JSON.parse(fs.readFileSync(file, 'utf8')).tier) || 0; } catch { return 0; }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = input ? JSON.parse(input) : {};
    const transcriptPath = data.transcript_path;
    if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

    const u = readUsage(transcriptPath);
    if (!u || !u.loaded) process.exit(0);

    const persisted = readPersistedContext(data.session_id);
    const win = windowTokens(u.model, u.has1m, u.loaded, persisted?.size);
    const pct = (u.loaded / win) * 100;
    const threshold = thresholdPct();
    if (pct < threshold) process.exit(0);

    // Highest tier we've crossed but not yet warned for this session.
    const file = stampFile(data.session_id);
    const warned = lastTier(file);
    const crossed = tiersFor(threshold).filter(t => pct >= t && t > warned);
    if (crossed.length === 0) process.exit(0);
    const tier = crossed[crossed.length - 1];

    try { fs.writeFileSync(file, JSON.stringify({ tier, ts: Date.now() })); } catch { /* non-fatal */ }

    const kLoaded = Math.round(u.loaded / 1000);
    const kWin = Math.round(win / 1000);
    process.stdout.write(
      `⚠️ CONTEXT BUDGET — ~${pct.toFixed(0)}% of the context window used ` +
      `(~${kLoaded}k / ${kWin}k tokens; warn threshold ${threshold}%). ` +
      `Native auto-compact won't fire until ~78%. Run \`/compact\` now to summarize ` +
      `and free space before context gets tight. (braynee context-budget hook)`
    );
  } catch { /* never block the prompt */ }
  process.exit(0);
});
