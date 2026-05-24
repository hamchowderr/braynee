#!/usr/bin/env node
/**
 * SessionStart hook — ensures Obsidian is running before vault CLI calls,
 * coordinated across concurrent sessions and silent on Windows.
 *
 * The old version launched Obsidian eagerly and polled `obsidian vault`
 * every 1s for 15s via execSync WITHOUT windowsHide — run independently by
 * EVERY session. With multiple terminals / IDE sessions (a common Claude Code
 * workflow) that meant redundant launches, wasted CPU, and a console-flash
 * storm. This version (cp-am8):
 *   - cached-ready stamp (TTL): if any session confirmed Obsidian ready
 *     recently, exit instantly — no checks, no flashes.
 *   - single-flight lock: only ONE session does the launch + poll; the rest
 *     bow out immediately.
 *   - windowsHide on every spawn: zero console pops.
 *   - gentle backoff instead of 1s × 15s hammering.
 *
 * Cross-platform: detects the Obsidian install path on Windows/macOS/Linux.
 */
import { execSync, spawn } from 'child_process';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { homedir, platform, tmpdir } from 'os';
import { join } from 'path';

// Trust a recent "ready" confirmation from any session for this long before
// re-checking. Short enough that a closed Obsidian is noticed reasonably soon;
// long enough that a burst of session starts does at most one real check.
const READY_TTL_MS = 3 * 60 * 1000; // 3 min
// A single ensure attempt (launch + backoff poll) caps well under this; an
// older lock is presumed dead and stolen.
const LOCK_STALE_MS = 30 * 1000;
// Backoff poll schedule (~15s total), replacing the old 1s × 15 loop.
const POLL_SCHEDULE_MS = [1000, 2000, 4000, 8000];

// execSync defaults: hide the console window (the whole point of this fix)
// and never let a child's stderr leak to the user.
const EXEC = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true };

function controlDir() {
  const dir = join(homedir(), '.cache', 'braynee');
  try { mkdirSync(dir, { recursive: true }); return dir; } catch { return tmpdir(); }
}
const READY_STAMP = join(controlDir(), '.braynee-obsidian-ready.stamp');
const ENSURE_LOCK = join(controlDir(), '.braynee-obsidian-ensure.lock');

function stampFresh() {
  try {
    return (Date.now() - Number(readFileSync(READY_STAMP, 'utf8').trim())) < READY_TTL_MS;
  } catch { return false; }
}
function writeStamp() { try { writeFileSync(READY_STAMP, String(Date.now())); } catch { /* non-fatal */ } }

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Single-flight: returns true only if this process now owns the ensure lock.
// Steals a stale/dead lock once.
function acquireLock() {
  const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
  try { writeFileSync(ENSURE_LOCK, payload, { flag: 'wx' }); return true; }
  catch (e) { if (e.code !== 'EEXIST') return false; }
  try {
    const cur = JSON.parse(readFileSync(ENSURE_LOCK, 'utf8'));
    if (!cur || (Date.now() - (cur.ts || 0)) > LOCK_STALE_MS || !pidAlive(cur.pid)) {
      writeFileSync(ENSURE_LOCK, payload);
      return true;
    }
  } catch {
    try { writeFileSync(ENSURE_LOCK, payload); return true; } catch { /* ignore */ }
  }
  return false;
}
function releaseLock() { try { unlinkSync(ENSURE_LOCK); } catch { /* already gone */ } }

function findObsidianExe() {
  const home = homedir();
  const plat = platform();
  const candidates = [];
  if (plat === 'win32') {
    candidates.push(join(home, 'AppData', 'Local', 'Programs', 'Obsidian', 'Obsidian.exe'));
    candidates.push('C:/Program Files/Obsidian/Obsidian.exe');
  } else if (plat === 'darwin') {
    candidates.push('/Applications/Obsidian.app/Contents/MacOS/Obsidian');
    candidates.push(join(home, 'Applications/Obsidian.app/Contents/MacOS/Obsidian'));
  } else {
    candidates.push('/usr/bin/obsidian');
    candidates.push('/usr/local/bin/obsidian');
    candidates.push('/opt/Obsidian/obsidian');
    candidates.push(join(home, '.local/bin/obsidian'));
    candidates.push('/snap/bin/obsidian');
  }
  return candidates.find(p => existsSync(p)) || null;
}

function isObsidianRunning() {
  try {
    const cmd = platform() === 'win32'
      ? 'tasklist /FI "IMAGENAME eq Obsidian.exe" /NH'
      : 'pgrep -i obsidian';
    return execSync(cmd, EXEC).toLowerCase().includes('obsidian');
  } catch { return false; }
}

function isCliReady() {
  try { execSync('obsidian vault', { ...EXEC, timeout: 3000 }); return true; }
  catch { return false; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  // 1. Another session confirmed Obsidian ready recently → nothing to do.
  if (stampFresh()) process.exit(0);

  // 2. Single-flight: if another session is already ensuring, bow out.
  if (!acquireLock()) process.exit(0);

  try {
    // 3. Already up and responsive? One quiet check, stamp, done.
    if (isObsidianRunning() && isCliReady()) { writeStamp(); return; }

    // 4. Launch if needed (quiet). On Windows `start ""` lets the shell honor
    //    Obsidian's single-instance lock; elsewhere a detached spawn is fine.
    if (!isObsidianRunning()) {
      const exe = findObsidianExe();
      if (!exe) {
        console.log('WARNING: Obsidian not found in standard locations. Open it manually if you need vault commands.');
        return;
      }
      console.log('Obsidian is not running — launching it quietly…');
      if (platform() === 'win32') {
        execSync(`start "" "${exe}"`, { stdio: 'ignore', windowsHide: true });
      } else {
        spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      }
    }

    // 5. Gentle backoff poll for CLI readiness; stamp on success.
    for (const wait of POLL_SCHEDULE_MS) {
      await sleep(wait);
      if (isCliReady()) { writeStamp(); return; }
    }
    console.log('WARNING: Obsidian CLI not ready yet. Vault commands may fail until Obsidian finishes loading.');
  } finally {
    releaseLock();
    process.exit(0);
  }
}

main();
