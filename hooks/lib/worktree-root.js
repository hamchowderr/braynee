'use strict';

// worktree-root.js — the main repository folder for a git worktree. cp-4kcp.
//
// session-auto-track names a session's project after its folder. Inside a
// worktree that folder is the worktree's own name (`.claude/worktrees/foo`,
// or a sibling checkout such as `repo-xyz`), so every worktree became its own
// project note and Sessions folder. The project is the repository the
// worktree belongs to; only the branch differs.
//
//   mainRepoRoot(dir) → the main checkout's folder, or `dir` unchanged when
//                       it is not a linked worktree.

const path = require('path');
const { execFileSync } = require('child_process');

const WORKTREES_SEGMENT = /[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/i;

function same(a, b) {
  const n = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

// Ask git: a linked worktree's common git dir is the main checkout's `.git`.
function fromGit(dir) {
  try {
    const opts = { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, windowsHide: true };
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], opts).trim();
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], opts).trim();
    if (!common || !top || path.basename(common) !== '.git') return null;
    const main = path.dirname(common);
    return same(main, top) ? null : main;
  } catch {
    return null;
  }
}

// When git cannot answer (folder gone, git missing), a Claude Code worktree
// still shows in its path.
function fromPath(dir) {
  const m = dir.match(WORKTREES_SEGMENT);
  return m ? dir.slice(0, m.index) : null;
}

function mainRepoRoot(dir) {
  if (!dir) return dir;
  return fromGit(dir) || fromPath(dir) || dir;
}

module.exports = { mainRepoRoot, fromPath };
