#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'qmd-sync';

try {
  const qmdPath = path.join(os.homedir(), '.claude', 'scripts', 'qmd-wrapper.mjs');
  if (!fs.existsSync(qmdPath)) {
    log.warn(HOOK, `qmd-wrapper.mjs not found at ${qmdPath} — skipping index`);
    process.exit(0);
  }

  const child = spawn('node', [qmdPath, 'index'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  log.info(HOOK, 'spawned qmd index (detached)');
} catch (err) {
  log.error(HOOK, `unhandled error: ${err.message}`);
  process.exit(0);
}
