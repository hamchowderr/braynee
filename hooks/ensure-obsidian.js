#!/usr/bin/env node
/**
 * SessionStart hook — ensures Obsidian is running before vault CLI calls.
 * Launches the app if not found, then polls until the CLI responds.
 * Cross-platform: detects Obsidian install path on Windows / macOS / Linux.
 */
import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 15000;

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
    // Linux — try standard locations
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
    const plat = platform();
    let cmd;
    if (plat === 'win32') {
      cmd = 'tasklist /FI "IMAGENAME eq Obsidian.exe" /NH';
    } else {
      cmd = 'pgrep -i obsidian';
    }
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return out.toLowerCase().includes('obsidian');
  } catch {
    return false;
  }
}

function isCliReady() {
  try {
    execSync('obsidian vault', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  if (isObsidianRunning() && isCliReady()) {
    process.exit(0);
  }

  if (!isObsidianRunning()) {
    const exe = findObsidianExe();
    if (!exe) {
      console.log('WARNING: Obsidian executable not found in standard locations. Open Obsidian manually if you need vault commands.');
      process.exit(0);
    }
    console.log('Obsidian is not running — launching it now...');
    // On Windows, use `start ""` so Windows shell handles Obsidian's
    // single-instance lock correctly. A direct detached spawn (the old
    // approach) leaves a windowless zombie process behind because the
    // second-instance helper can't exit cleanly when its stdio is
    // detached — Windows then routes user taskbar clicks to the zombie
    // (most-recent PID) instead of the real visible window.
    // On macOS/Linux, detached spawn behaves correctly.
    if (platform() === 'win32') {
      execSync(`start "" "${exe}"`, { stdio: 'ignore', windowsHide: true });
    } else {
      spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
    }
  } else {
    console.log('Obsidian is running but CLI not yet ready — waiting...');
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (isCliReady()) {
      console.log('Obsidian CLI is ready.');
      process.exit(0);
    }
  }

  console.log('WARNING: Obsidian CLI did not become ready within 15s. Vault commands may fail — check that Obsidian is open.');
  process.exit(0);
}

main();
