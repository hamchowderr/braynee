// statusline-resync.js
// Hook: SessionStart — keep the active status-line copy current with the
// shipped renderer.
//
// The `statusLine` setting points at a STATIC ~/.claude/statusline.js (written
// once by /setup) rather than the versioned plugin path, which changes on
// every update. Without this, renderer improvements never reach users after a
// plugin update — the copy silently drifts (observed: active 267 lines vs
// shipped 280). This copies the shipped renderer over whenever they differ, so
// status-line fixes propagate on the next session. Silent, best-effort,
// exits 0. See cp-bw8.

const fs = require('fs');
const path = require('path');
const os = require('os');

try {
  const shipped = path.join(__dirname, 'statusline.js');
  const active = path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'statusline.js');
  const shippedSrc = fs.readFileSync(shipped, 'utf8');
  let activeSrc = null;
  try { activeSrc = fs.readFileSync(active, 'utf8'); } catch { /* missing — will create */ }
  if (shippedSrc !== activeSrc) {
    fs.writeFileSync(active, shippedSrc);
  }
} catch (e) {
  // When this fails the user keeps running an OUTDATED statusline indefinitely
  // — it still renders, so nothing looks wrong.
  try {
    require(path.join(__dirname, 'lib', 'hook-logger.js'))
      .debug('statusline-resync', `could not sync statusline.js: ${e && e.message}`);
  } catch { /* never block session start to log */ }
}

process.exit(0);
