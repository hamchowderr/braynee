#!/usr/bin/env node
'use strict';

// braynee-heartbeat.js
// Hook: SessionStart — lightweight sentinel proving Braynee's hooks are LIVE.
//
// HD-6.2 / cp-6nk: if a user has disableAllHooks:true, a managed policy
// disabling hooks, or a Claude Code old enough not to honor plugin
// hooks/hooks.json, EVERY Braynee lifecycle guarantee silently dies — no
// session tracking, no beads surface, no guards — with zero signal that
// "Braynee is installed but inert". For a universal plugin that is the worst
// failure mode (looks installed, does nothing, no error).
//
// This hook does exactly one cheap thing: write a heartbeat file with the
// current timestamp. The settings-viewer dashboard reads it and shows
// "hooks live? yes / stale" — if this hook never runs, the file goes stale
// and the dashboard flags it. No output to Claude (silent, side-effect only).

const fs = require('fs');
const os = require('os');
const path = require('path');

const HEARTBEAT_FILE = path.join(os.homedir(), '.claude', 'braynee-hooks-heartbeat');

try {
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    plugin: 'braynee',
  });
  fs.mkdirSync(path.dirname(HEARTBEAT_FILE), { recursive: true });
  fs.writeFileSync(HEARTBEAT_FILE, payload + '\n', 'utf8');
} catch {
  // Best-effort sentinel; never fail the session start.
}
process.exit(0);
