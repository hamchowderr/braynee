// projects-root.js
// Shared resolver for the directory that holds the user's code project repos.
//
// brainy is a universal plugin. The PRD subsystem historically hardcoded the
// PRD<->repo join as `~/code/<folder>` (prd-audit, prd-seed, beads-dashboard,
// and the PRD schema/docs). Hundreds of users have no `~/code`, so any such
// assumption is a guaranteed failure. This module is the single source of
// truth for "where do project repos live".
//
// Resolution order (first hit wins):
//   1. BRAINY_PROJECTS_DIR   — the canonical, documented override
//   2. BEADS_CODE_DIR        — legacy var beads-dashboard.js already honored;
//                              kept for back-compat so existing setups don't break
//   3. <home>/code           — historical default, ONLY when nothing is set
//                              (back-compat, never a hard requirement)
//
// A configured value is expanded for a leading `~` / `~/` and resolved to an
// absolute path. The default is NOT required to exist — callers decide how to
// treat a missing root (prd-audit warns, prd-seed errors, beads-dashboard
// silently finds nothing).
//
// CommonJS so it can be `require`d by beads-dashboard.js (CJS) and imported
// from the .mjs scripts via module.createRequire — one synchronous source of
// truth, no async/dual-build complexity.

'use strict';

const os = require('os');
const path = require('path');

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Absolute path of the configured (or default) projects root.
 * Pure: reads env + os.homedir(), touches no filesystem.
 */
function getProjectsDir(env = process.env) {
  const configured = env.BRAINY_PROJECTS_DIR || env.BEADS_CODE_DIR;
  if (configured && String(configured).trim()) {
    return path.resolve(expandHome(String(configured).trim()));
  }
  return path.join(os.homedir(), 'code');
}

/**
 * True when the projects root came from an explicit override (vs. the
 * historical ~/code default). Lets callers phrase messages accurately
 * ("not found at <root>" vs. "set BRAINY_PROJECTS_DIR").
 */
function isProjectsDirConfigured(env = process.env) {
  return Boolean(
    (env.BRAINY_PROJECTS_DIR && String(env.BRAINY_PROJECTS_DIR).trim()) ||
    (env.BEADS_CODE_DIR && String(env.BEADS_CODE_DIR).trim())
  );
}

/** Absolute path of a single project repo within the projects root. */
function projectRepoPath(folder, env = process.env) {
  return path.join(getProjectsDir(env), folder);
}

module.exports = {
  getProjectsDir,
  isProjectsDirConfigured,
  projectRepoPath,
  expandHome,
};
