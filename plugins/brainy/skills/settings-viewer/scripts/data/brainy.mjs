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
