#!/usr/bin/env node
/**
 * SessionStart hook — ensures Obsidian is running before vault CLI calls.
 * Launches the app if not found, then polls until the CLI responds.
 */
import { execSync, spawn } from 'child_process';

const OBSIDIAN_EXE = 'C:/Users/HamCh/AppData/Local/Programs/Obsidian/Obsidian.exe';
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 15000;

function isObsidianRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Obsidian.exe" /NH', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return out.toLowerCase().includes('obsidian.exe');
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
    // Already up — silent exit
    process.exit(0);
  }

  if (!isObsidianRunning()) {
    console.log('Obsidian is not running — launching it now...');
    spawn(OBSIDIAN_EXE, [], { detached: true, stdio: 'ignore' }).unref();
  } else {
    console.log('Obsidian is running but CLI not yet ready — waiting...');
  }

  // Poll until CLI responds or timeout
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (isCliReady()) {
      console.log('Obsidian CLI is ready.');
      process.exit(0);
    }
  }

  console.log('WARNING: Obsidian CLI did not become ready within 15s. Vault commands may fail — check that Obsidian is open.');
  process.exit(0); // non-blocking exit so session still starts
}

main();
