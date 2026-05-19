#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_FILE = path.join(os.homedir(), '.claude', 'braynee-hooks.log');
const MAX_SIZE = 1024 * 1024; // 1MB — rotate beyond this

function write(level, hookName, message) {
  const line = `${new Date().toISOString()} ${level} [${hookName}] ${message}\n`;
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_SIZE) {
      try { fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch {}
    }
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    process.stderr.write(line);
  }
}

module.exports = {
  info:  (hook, msg) => write('INFO ', hook, msg),
  warn:  (hook, msg) => write('WARN ', hook, msg),
  error: (hook, msg) => write('ERROR', hook, msg),
};
