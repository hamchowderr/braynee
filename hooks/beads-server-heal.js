#!/usr/bin/env node
'use strict';

// beads-server-heal.js
// Hook: SessionStart — heal a dead / wedged / squatted shared Dolt server so
// that `bd` actually works for the rest of the session.
//
// WHY THIS EXISTS (cp-6j5). Recurring failure, observed 2026-05-14/21/25/27/31:
// the shared Dolt server idles out and shuts down between sessions. When it dies
// uncleanly, the configured port (e.g. 3308) is left in one of two bad states:
//   (a) WEDGED   — a dolt process still LISTENs but aborts every handshake; or
//   (b) SQUATTED — a foreign/per-project dolt server grabs the port pointing at
//                  the wrong data-dir.
// In BOTH cases `bd dolt test` reports "connection OK" (something answers on the
// port), yet every real query fails with `database "<prefix>" not found`. bd's
// own auto-start sees "a server is up" and never restarts it, and an explicit
// `bd dolt start` REFUSES with "port in use by another project's dolt server
// (PID N)". So nothing self-heals — the user hand-kills the squatter and
// restarts the server, every single time.
//
// check-beads-init.js only handles the "beads not initialized" case (it
// early-exits the moment `.beads/` exists). Nothing checks "is the server
// actually serving MY database, and fix it if not." This hook fills that gap.
//
// ALGORITHM (silent on the happy path):
//   1. Gate: session is a code context with a REAL initialized .beads/ (not a
//      bare marker dir). bd on PATH. Otherwise exit 0, silent.
//   2. Probe: `bd stats`. If it opens the DB → healthy → exit 0, silent.
//   3. Heal attempt 1: `bd dolt start`. If it starts and the re-probe passes →
//      the server was simply DOWN (port free) → report & exit.
//   4. Heal attempt 2 (only if start failed with "port in use by another
//      project's dolt server (PID N)"): that error is bd's OWN classification
//      that the squatter is a dolt server, and our probe already proved it is
//      NOT serving our DB. Triple-gated, so we reclaim the port: verify the PID
//      is a dolt process, kill it, clear stale locks, retry `bd dolt start`,
//      re-probe.
//   5. If still broken → emit a diagnostic block so Claude can surface it.
//
// SAFETY: a process is killed ONLY when all hold — (a) our DB probe failed,
// (b) `bd dolt start` failed specifically with bd's "another project's dolt
// server (PID N)" message, and (c) the PID resolves to a dolt process. An
// unrelated app on the port is never touched.
//
// Pure helpers (parseStartError / isDbNotFound / pidLooksLikeDolt / pidOnPort)
// are exported for unit testing; the stdin/heal logic runs only as `main`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const HOOK = 'beads-server-heal';

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// Parse bd's port-in-use refusal:
//   "cannot start dolt server on port 3308: port 3308 is in use by another
//    project's dolt server (PID 17864)."
// Returns { port, pid } with numbers, or nulls when a field is absent.
function parseStartError(stderr) {
  const text = String(stderr || '');
  const portM = text.match(/port\s+(\d{2,5})\b/i);
  const pidM = text.match(/\bPID\s+(\d+)/i);
  return {
    port: portM ? Number(portM[1]) : null,
    pid: pidM ? Number(pidM[1]) : null,
    isPortInUse: /in use by another/i.test(text),
  };
}

// The symptom that proves the server-on-the-port is not serving our DB.
function isDbNotFound(text) {
  return /database\s+"?[^"\s]+"?\s+not found/i.test(String(text || ''));
}

// Best-effort: does this PID belong to a dolt process? Cross-platform, no deps.
// Returns true only on a positive identification; false when unknown (so an
// unidentifiable PID is never killed).
function pidLooksLikeDolt(pid, runner, platform) {
  if (!pid || pid <= 0) return false;
  const run = runner || defaultRunner;
  // `platform` is injectable so the win32 (tasklist CSV) and posix (ps comm)
  // parse paths are both testable on any OS — otherwise a win32-format fixture
  // can never pass on a Linux/macOS CI runner (the matrix that caught this).
  const plat = platform || process.platform;
  try {
    if (plat === 'win32') {
      const out = run('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV']);
      return /(^|[",])"?dolt(\.exe)?"?/i.test(out) || /dolt\.exe/i.test(out);
    }
    const out = run('ps', ['-p', String(pid), '-o', 'comm=']);
    return /(^|\/)dolt\b/i.test(out.trim());
  } catch {
    return false;
  }
}

// Best-effort: which PID is LISTENing on a TCP port? Fallback for when bd's
// error text didn't include the PID. Cross-platform, no deps.
function pidOnPort(port, runner) {
  if (!port) return null;
  const run = runner || defaultRunner;
  try {
    if (process.platform === 'win32') {
      const out = run('netstat', ['-ano']);
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        if (!new RegExp(`[:.]${port}\\b`).test(line)) continue;
        const m = line.trim().match(/(\d+)\s*$/);
        if (m) return Number(m[1]);
      }
      return null;
    }
    // POSIX: lsof is the most portable listener->pid mapping.
    const out = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    const first = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    return first ? Number(first) : null;
  } catch {
    return null;
  }
}

function defaultRunner(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
}

// ── Runtime-only helpers ─────────────────────────────────────────────────────

function bd(argStr, cwd) {
  try {
    const out = execSync(`bd ${argStr}`, {
      cwd, encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    return { ok: true, out: out || '', err: '' };
  } catch (e) {
    return { ok: false, out: e.stdout ? e.stdout.toString() : '', err: e.stderr ? e.stderr.toString() : (e.message || '') };
  }
}

function bdOnPath() {
  try {
    execSync('bd --version', { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// A REAL initialized .beads/ — not the bare marker dir the self-test creates.
// We require at least one concrete bd artifact so we never run bd against an
// empty placeholder (which would be slow or have side effects).
function beadsLooksInitialized(beadsRoot) {
  const beadsDir = path.join(beadsRoot, '.beads');
  for (const f of ['metadata.json', 'config.yaml', 'issues.jsonl']) {
    if (fs.existsSync(path.join(beadsDir, f))) return true;
  }
  for (const d of ['dolt', 'embeddeddolt']) {
    if (fs.existsSync(path.join(beadsDir, d))) return true;
  }
  return false;
}

function probeHealthy(cwd) {
  // `bd stats` opens the database: it succeeds when the server serves our DB,
  // and fails with `database "<prefix>" not found` (server up, wrong DB) or a
  // connection error (server down). Either failure means "unhealthy".
  return bd('stats', cwd);
}

function clearStaleLocks(beadsRoot) {
  const candidates = [
    path.join(beadsRoot, '.beads', 'dolt-server.lock'),
    path.join(beadsRoot, '.beads', 'dolt-server.pid'),
  ];
  try {
    const shared = path.join(os.homedir(), '.beads', 'shared-server');
    candidates.push(path.join(shared, 'dolt-server.lock'));
    candidates.push(path.join(shared, '.dolt-pid'));
  } catch {}
  for (const f of candidates) {
    try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch {}
  }
}

function killPid(pid) {
  try { process.kill(pid, 'SIGKILL'); return true; } catch { /* fallthrough */ }
  // Windows fallback if SIGKILL mapping failed.
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/PID', String(pid)], {
        encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      return true;
    } catch {}
  }
  return false;
}

function emit(md) { process.stdout.write(md); }

function heal(cwd) {
  // 1. Already healthy? Silent.
  if (probeHealthy(cwd).ok) {
    log.info(HOOK, 'server healthy — nothing to do');
    return;
  }

  log.warn(HOOK, 'bd database unreachable — attempting heal');

  // 2. Attempt a plain start (covers the "server simply down, port free" case).
  let start = bd('dolt start', cwd);
  if (start.ok && probeHealthy(cwd).ok) {
    log.info(HOOK, 'healed by starting the down server');
    emit(
      `# Beads server healed\n\n` +
      `The shared Dolt server was down at session start; braynee ran ` +
      `\`bd dolt start\` and \`bd\` is working again. No action needed.\n\n`
    );
    return;
  }

  // 3. Port-in-use: a wedged/foreign dolt server squats the port and is not
  //    serving our DB (our probe already failed). Reclaim it — triple-gated.
  const info = parseStartError(start.err);
  if (info.isPortInUse) {
    const port = info.port;
    const pid = info.pid || pidOnPort(port);
    log.warn(HOOK, `port ${port || '?'} squatted by PID ${pid || '?'} (not serving our DB)`);

    if (pid && pidLooksLikeDolt(pid)) {
      const killed = killPid(pid);
      log.warn(HOOK, `kill squatter PID ${pid}: ${killed ? 'ok' : 'FAILED'}`);
      if (killed) {
        clearStaleLocks(cwd);
        start = bd('dolt start', cwd);
        if (start.ok && probeHealthy(cwd).ok) {
          log.info(HOOK, `healed: cleared squatter PID ${pid}, restarted server`);
          emit(
            `# Beads server healed\n\n` +
            `A wedged Dolt server (PID ${pid}) was squatting port ${port} without ` +
            `serving this project's database — the recurring cp-6j5 failure. braynee ` +
            `killed it and restarted the shared server; \`bd\` is working again.\n\n`
          );
          return;
        }
      }
    } else {
      log.warn(HOOK, `PID ${pid || '?'} not confirmed as dolt — refusing to kill`);
    }
  }

  // 4. Could not heal automatically — hand Claude a concrete next step.
  log.error(HOOK, `heal failed: ${(start.err || '').split('\n')[0]}`);
  emit(
    `# Beads server unreachable\n\n` +
    `\`bd\` cannot open its database and braynee could not auto-heal the shared ` +
    `Dolt server (cp-6j5). Diagnose with \`bd doctor\` and \`bd dolt status\`, then ` +
    `either free the configured port and run \`bd dolt start\`, or recover with ` +
    `\`bd bootstrap\`.\n\n` +
    `Last error: \`${(start.err || 'unknown').split('\n')[0]}\`\n\n`
  );
}

// ── Wire-up (runs only when invoked directly, not when required by tests) ─────

let log = { info() {}, warn() {}, error() {} };

if (require.main === module) {
  log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
  const { findBeadsRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { input += c; });
  process.stdin.on('end', () => {
    try {
      let data = {};
      if (input) { try { data = JSON.parse(input); } catch { data = {}; } }

      // Gate on the SESSION's working dir (anchored), same as check-beads-init.
      const beadsRoot = findBeadsRoot(sessionDir(data));
      if (!beadsRoot) { process.exit(0); }
      if (!beadsLooksInitialized(beadsRoot)) { process.exit(0); }
      if (!bdOnPath()) { process.exit(0); }

      heal(beadsRoot);
      process.exit(0);
    } catch (e) {
      try { log.error(HOOK, `crash: ${e.message}`); } catch {}
      process.exit(0);
    }
  });
}

module.exports = { parseStartError, isDbNotFound, pidLooksLikeDolt, pidOnPort, beadsLooksInitialized };
