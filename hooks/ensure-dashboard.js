#!/usr/bin/env node
'use strict';

// ensure-dashboard.js
// Hook: SessionStart — keep the Second Brain Dashboard server running whenever
// Claude Code is running, IF the user opted in with BRAYNEE_DASHBOARD_MODE=server.
//
// The dashboard server is infrastructure, not a skill you invoke: in server mode
// it should simply be up for the life of Claude Code. This hook makes that true.
// It is cheap and idempotent — the server is a fixed-port singleton, so on every
// session after the first this just probes a port and exits; only the first
// session of a cold machine actually spawns it.
//
// Gates:
//   - BRAYNEE_DASHBOARD_MODE !== 'server'  → no-op (file mode, the default).
// Properties: silent, no window (windowsHide), never blocks session start (async
// in hooks.json + detached spawn that we don't wait on), no dashboard
// regeneration (that's the server's own background job), never opens a browser.
const { spawn } = require('child_process');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const HOOK = 'ensure-dashboard';

try {
  if (String(process.env.BRAYNEE_DASHBOARD_MODE || '').toLowerCase() !== 'server') {
    process.exit(0);
  }

  // Reuse the single source of truth for server lifecycle. `--ensure` probes the
  // singleton and starts it only if it's down, then exits.
  const lifecycle = path.join(
    __dirname, '..', 'skills', 'settings-viewer', 'scripts', 'lifecycle.mjs'
  );

  const child = spawn(process.execPath, [lifecycle, '--ensure'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();
} catch (e) {
  // A dashboard that never starts is indistinguishable from one the user
  // simply has not opened, so the failure needs a record of its own.
  try { log.debug(HOOK, `dashboard spawn failed: ${e && e.message}`); } catch { /* logging must never break the hook */ }
  /* non-fatal — a dashboard that fails to start must never break a session */
}

process.exit(0);
