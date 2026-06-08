// Singleton lifecycle for the Second Brain Dashboard server (server mode).
//
// ensureServer() is idempotent and safe to call from every session: it probes
// the fixed port, and only spawns a detached server if one isn't already serving.
// The fixed port + EADDRINUSE guard in server.mjs means even a race between two
// sessions resolves to exactly one live server (the second spawn exits quietly).
//
// This mirrors the proven shape of hooks/beads-server-heal.js (probe → start if
// down) but is simpler: it's our own server on a private port, so there's no
// foreign-squatter reclaim to do — a failed probe just means "not up yet".
import http from 'http';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HOST = '127.0.0.1';
const PORT = Number(process.env.BRAYNEE_DASHBOARD_PORT) || 7717;
const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.mjs');

export function dashboardUrl() { return `http://${HOST}:${PORT}`; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns true only when something on the port answers /healthz AND identifies
// as the braynee dashboard — so an unrelated app on the port never reads as "up".
export function probe(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`http://${HOST}:${PORT}/healthz`, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).service === 'braynee-dashboard'); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Idempotent: ensure the singleton is serving, then return its URL. Starts the
// server only if it isn't already up. Detached + windowsHide so it outlives this
// process and never flashes a console on Windows.
export async function ensureServer({ waitMs = 12000 } = {}) {
  if (await probe()) return dashboardUrl();

  const child = spawn(process.execPath, [SERVER], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(300);
    if (await probe()) return dashboardUrl();
  }
  throw new Error(`braynee dashboard server did not become ready on ${dashboardUrl()} within ${waitMs}ms`);
}

// CLI entry: `node lifecycle.mjs [--ensure|--probe|--url]`. Used by the health
// skill / hooks to bring the server up and print the URL.
if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/') ||
    process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2] || '--ensure';
  if (arg === '--url') {
    process.stdout.write(dashboardUrl() + '\n');
  } else if (arg === '--probe') {
    probe().then((up) => { process.stdout.write((up ? 'up' : 'down') + '\n'); process.exit(up ? 0 : 1); });
  } else {
    ensureServer()
      .then((url) => { process.stdout.write(url + '\n'); process.exit(0); })
      .catch((e) => { process.stderr.write(String((e && e.message) || e) + '\n'); process.exit(1); });
  }
}
