#!/usr/bin/env node
// Entry point for the Second Brain Dashboard — routes to the user's chosen mode.
//
//   BRAYNEE_DASHBOARD_MODE = file   (default) → static HTML via generate.mjs
//   BRAYNEE_DASHBOARD_MODE = server          → live localhost server (singleton)
//   BRAYNEE_DASHBOARD_PORT = 7717   (server mode only, optional)
//
// Everything that opens the dashboard (the /health skill, manual runs) calls THIS
// so the file-vs-server choice lives in one place. Default `file` means existing
// users are unaffected; opting into `server` is a single env flag.
//
// Flags: --no-open suppresses opening a viewer (just refresh/ensure).
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mode = (process.env.BRAYNEE_DASHBOARD_MODE || 'file').toLowerCase();
const noOpen = process.argv.includes('--no-open');

// Open a URL in Obsidian's web viewer if available, else the default browser.
function openUrl(url) {
  try { execFileSync('obsidian', ['web', `url=${url}`], { stdio: 'ignore', windowsHide: true }); return; } catch { /* fall through */ }
  try {
    if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true });
    else if (process.platform === 'darwin') execFileSync('open', [url], { stdio: 'ignore' });
    else execFileSync('xdg-open', [url], { stdio: 'ignore' });
  } catch { /* best-effort */ }
}

if (mode === 'server') {
  // Ensure the singleton server is up (idempotent), then point the viewer at it.
  // The server is a persistent singleton: once started it stays up for all
  // sessions, so this is effectively always-on after first open.
  const { ensureServer } = await import('./lifecycle.mjs');
  const url = await ensureServer();
  console.log(url);
  if (!noOpen) openUrl(url);
} else {
  // File mode: delegate to generate.mjs, which writes the HTML and (unless
  // --no-open) handles opening it with its own TTL logic.
  const args = [join(__dirname, 'generate.mjs')];
  if (noOpen) args.push('--no-open');
  execFileSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
}
