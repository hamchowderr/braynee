// transcript-dir.js
// Shared helper: locate a Claude Code per-project transcript directory from a
// cwd, universally (any user, any OS, any project location).
//
// Claude Code stores session transcripts under
//   <home>/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// where <encoded-cwd> is the absolute cwd with EVERY character that is not
// [A-Za-z0-9-] replaced by a single '-'. No run-collapsing, no trimming.
// Verified against real ~/.claude/projects/ dirs on disk:
//   C:\Users\jane\dev\my-app          -> C--Users-jane-dev-my-app
//   C:\Users\HamCh\Obsidian Vault     -> C--Users-HamCh-Obsidian-Vault
//   C:\Users\HamCh\Obsidian Vault\1. Projects
//                                     -> C--Users-HamCh-Obsidian-Vault-1--Projects
//   /home/jane/work/my-app            -> -home-jane-work-my-app
//
// This was previously hardcoded as `C--Users-HamCh-code-<folder>` in
// session-auto-track.js (one username + repos under ~/code; cp-d9g / S-1) and
// re-implemented inline in session-auto-close.js with a DIFFERENT, incorrect
// algorithm (/[:\\/]+/g collapse + trim → "C-Users-..." which never matched
// the real "C--Users-..." dirs). Centralizing the verified encoding here
// removes the non-universal hardcode AND fixes that latent mismatch.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Encode an absolute cwd to its Claude Code transcript-dir name.
 * Every char outside [A-Za-z0-9-] becomes '-' (no collapsing, no trimming) —
 * matches Claude Code's actual on-disk encoding (verified, see header).
 * Pure: string in, string out. No filesystem access.
 */
function encodeCwd(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9-]/g, '-');
}

/**
 * Absolute path of the transcript dir for a cwd (whether or not it exists).
 */
function transcriptDirFor(cwd, home = os.homedir()) {
  return path.join(home, '.claude', 'projects', encodeCwd(cwd));
}

/**
 * Resolve the transcript dir for a cwd, or null if it does not exist.
 */
function findTranscriptDir(cwd, home = os.homedir()) {
  const dir = transcriptDirFor(cwd, home);
  try {
    return fs.existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

module.exports = { encodeCwd, transcriptDirFor, findTranscriptDir };
