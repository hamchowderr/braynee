#!/usr/bin/env node
// Long-running HTTP server for the Second Brain Dashboard (server mode).
//
// Why a server (vs. the static file): the data load is expensive — loadBeadsStats
// alone is O(projects x issues), spawning hundreds of `bd` subprocesses and taking
// minutes. A static file can only be rebuilt by re-running that whole slow build.
// A long-running server instead holds a WARM CACHE and refreshes it behind the
// scenes, so every page load is instant and never more than REFRESH_MS stale.
//
// CRITICAL — process isolation: the data loaders use execSync (BLOCKING). If the
// server built in-process it would freeze its own event loop for minutes and stop
// answering everything (even /healthz). So rebuilds are delegated to a CHILD
// process running generate.mjs; the server only ever reads the resulting HTML file
// and serves it. Its event loop stays free the whole time.
//
// Delivery contract:
//   - Bound to 127.0.0.1 only → private to this machine, no network exposure.
//   - Managed singleton: a FIXED port gives natural single-flight — a second
//     instance hits EADDRINUSE and exits, leaving one server for all sessions.
//   - GET /         → live dashboard HTML (served from warm cache)
//   - GET /healthz  → cheap liveness probe with a braynee marker
import http from 'http';
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, unlinkSync, readFileSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HOST = '127.0.0.1';
const PORT = Number(process.env.BRAYNEE_DASHBOARD_PORT) || 7717;

// Cache freshness. The dashboard's data (CC config, usage, beads) changes slowly,
// so a few-minute background refresh keeps it effectively live without ever making
// a request wait on the multi-minute rebuild.
const REFRESH_MS = Number(process.env.BRAYNEE_DASHBOARD_REFRESH_MS) || 5 * 60 * 1000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATE = join(__dirname, 'generate.mjs');
const HTML_FILE = join(homedir(), '.claude', 'temp', 'settings-viewer.html');

function controlDir() {
  const dir = join(homedir(), '.cache', 'braynee');
  try { mkdirSync(dir, { recursive: true }); return dir; } catch { return tmpdir(); }
}
const STAMP = join(controlDir(), 'dashboard-server.json');

// ── Warm cache + stale-while-revalidate ──────────────────────────────────────
let cache = { html: null, builtAt: 0 };
let building = null; // in-flight rebuild promise; dedupes concurrent rebuilds

// Run the heavy build in a CHILD process so its blocking execSync never touches
// this server's event loop. generate.mjs writes HTML_FILE; we then read it in.
function runGenerate() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GENERATE, '--no-open'], {
      stdio: 'ignore', windowsHide: true, env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('generate.mjs exited ' + code))));
  });
}

async function rebuild() {
  // Single-flight: concurrent callers share one rebuild rather than each
  // launching the expensive generator.
  if (building) return building;
  building = (async () => {
    try {
      await runGenerate();
      cache = { html: readFileSync(HTML_FILE, 'utf8'), builtAt: Date.now() };
      return cache.html;
    } finally {
      building = null;
    }
  })();
  return building;
}

// Seed the cache instantly from whatever settings-viewer.html already exists
// (file mode, a previous server run, or the /health skill). Means the first
// visit is instant even on a fresh server start; a background refresh follows.
function seedFromDisk() {
  try {
    cache = { html: readFileSync(HTML_FILE, 'utf8'), builtAt: statSync(HTML_FILE).mtimeMs };
  } catch { /* no prior file — first request will build */ }
}

function isFresh() {
  return cache.html && (Date.now() - cache.builtAt) < REFRESH_MS;
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  // Cheap liveness probe — no build. The marker lets ensureServer confirm THIS
  // is the braynee dashboard and not some other app squatting the port.
  if (url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'braynee-dashboard', pid: process.pid, builtAt: cache.builtAt }));
    return;
  }
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  try {
    if (isFresh()) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(cache.html);
      return;
    }
    if (cache.html) {
      // Stale-while-revalidate: serve the stale page instantly, refresh behind it.
      rebuild().catch(() => {});
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(cache.html);
      return;
    }
    // Nothing cached and no file on disk: this one request waits for the first
    // build. The child process does the blocking work, so other requests
    // (and /healthz) stay responsive meanwhile.
    const html = await rebuild();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Dashboard build error: ' + ((e && e.message) || String(e)));
  }
});

server.on('error', (e) => {
  // Another instance already owns the port → we are redundant. Exit quietly;
  // the existing singleton serves everyone. This IS the single-flight guard.
  if (e && e.code === 'EADDRINUSE') { process.exit(0); }
  process.stderr.write('braynee-dashboard server error: ' + ((e && e.message) || String(e)) + '\n');
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  try {
    writeFileSync(STAMP, JSON.stringify({
      pid: process.pid, port: PORT, host: HOST, started: new Date().toISOString(),
    }));
  } catch { /* non-fatal */ }
  process.stdout.write(`braynee dashboard live at http://${HOST}:${PORT}\n`);

  // Instant warm cache from any existing file, then keep it fresh in the
  // background. The interval is unref'd so it never holds the process open.
  seedFromDisk();
  rebuild().catch(() => {});
  const timer = setInterval(() => { rebuild().catch(() => {}); }, REFRESH_MS);
  if (timer.unref) timer.unref();
});

function shutdown() {
  try { unlinkSync(STAMP); } catch { /* already gone */ }
  try { server.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
