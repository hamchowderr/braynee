import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// HD-6.2 / cp-6nk: read the SessionStart heartbeat sentinel
// (brainy-heartbeat.js). If hooks are disabled (disableAllHooks, policy, old
// CC that ignores plugin hooks), this file is missing or stale and the
// dashboard flags "Brainy installed but inert" — the worst silent failure
// mode for a universal plugin.
const HEARTBEAT_FILE = join(homedir(), '.claude', 'brainy-hooks-heartbeat');
// A session that started within this window means hooks are firing. Generous
// because SessionStart is the only writer and sessions can be long-lived.
const HEARTBEAT_FRESH_HOURS = 24;

export function computeHooksLive() {
  try {
    const raw = readFileSync(HEARTBEAT_FILE, 'utf8').trim();
    let ts = null;
    try { ts = JSON.parse(raw).ts; } catch { ts = raw; }
    const beatMs = Date.parse(ts);
    if (!Number.isFinite(beatMs)) return { live: false, state: 'unknown', lastBeat: null };
    const ageHours = (Date.now() - beatMs) / 3.6e6;
    return {
      live: ageHours <= HEARTBEAT_FRESH_HOURS,
      state: ageHours <= HEARTBEAT_FRESH_HOURS ? 'live' : 'stale',
      lastBeat: ts,
      ageHours,
    };
  } catch {
    // No heartbeat file at all — the SessionStart hook has never run.
    return { live: false, state: 'missing', lastBeat: null };
  }
}

const BRAINY_FEATURES = [
  { key: 'vault_context',    terms: ['vault-context','vault_context'] },
  { key: 'session_tracking', terms: ['session-tracker','session-export','session-auto-track'] },
  { key: 'qmd_sync',         terms: ['qmd-sync','qmd_sync'] },
  { key: 'statusline',       terms: null },
];

export function computeAllHookCmds(s) {
  const cmds = [];
  for (const [, entries] of Object.entries(s.hooks || {})) {
    for (const entry of entries) {
      for (const h of (entry.hooks || [])) { if (h.command) cmds.push(h.command); }
    }
  }
  return cmds;
}

export function computeBrainyHealth(s, allHookCmds) {
  let active = 0, missing = 0;
  for (const f of BRAINY_FEATURES) {
    const covered = f.terms
      ? f.terms.some(t => allHookCmds.some(c => c.includes(t)))
      : !!s.statusLine;
    if (covered) active++; else missing++;
  }
  return { active, missing, total: BRAINY_FEATURES.length };
}
