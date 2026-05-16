// is-code-context.js
// Shared helper: decide whether a directory is a "working on code" context.
//
// Brainy is a universal plugin. The old `cwd.startsWith(~/code)` gate assumed
// every user keeps repos under a single `~/code` directory — most do not.
// Instead, detect a code context structurally: walk up from the start dir
// looking for a language/project manifest or source files. A `.git` or
// `.beads` ancestor corroborates the signal but is NEVER required (the user
// may not use git at all).
//
// The per-event cwd a hook receives is TRANSIENT: a skill base dir or a
// `bash cd` inside the session flips it. Keying any gate off that cwd makes
// e.g. the beads Stop/SessionStart hooks fire inside a pure *vault* session
// just because one subprocess cd'd into ~/code. The stable signal is the
// SESSION's working directory — the cwd at SessionStart, before anything
// moved. Claude Code hook stdin only exposes { session_id, cwd } (no
// workspace/project_dir field), so we anchor the first cwd seen for a
// session_id and reuse it for every later hook in that session.
//
// Exports:
//   findCodeRoot(startDir)         → absolute path of detected project root, or null
//   findBeadsRoot(startDir)        → nearest ancestor with .beads/, excluding
//                                     $HOME/fs-root, or null
//   findGitRoot(startDir)          → nearest ancestor with .git, excluding
//                                     $HOME/fs-root, or null
//   isCodeContext(startDir)        → boolean (findCodeRoot !== null)
//   sessionDir({session_id, cwd})  → the stable session working dir (anchored
//                                     + cached per session_id)
//   isSessionCodeContext(stdin)    → boolean: is the SESSION (not this event)
//                                     working on code?
//
// Pure, synchronous, no external deps beyond fs. Safe to require from any hook.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// The user's home directory and the filesystem root are never project roots.
// `bd init --shared-server` drops a global `.beads/` in $HOME, and users may
// have a dotfiles `.git` there — neither marks a code project. Excluding these
// keeps the corroborating-dir signal from latching onto $HOME when a hook is
// invoked from an unrelated subtree (e.g. a temp or skill base dir).
let HOME_DIR = null;
try {
  HOME_DIR = path.resolve(os.homedir());
} catch {}

// Manifest / project files that unambiguously mark a project root.
// First match while walking up wins (closest ancestor = the project root).
const MANIFEST_FILES = [
  'package.json',        // Node / JS / TS
  'tsconfig.json',       // TypeScript
  'deno.json',           // Deno
  'deno.jsonc',
  'pyproject.toml',      // Python (PEP 518)
  'requirements.txt',    // Python
  'setup.py',            // Python
  'setup.cfg',           // Python
  'Pipfile',             // Python (pipenv)
  'go.mod',              // Go
  'Cargo.toml',          // Rust
  'pom.xml',             // Java (Maven)
  'build.gradle',        // Java/Kotlin (Gradle)
  'build.gradle.kts',
  'Gemfile',             // Ruby
  'composer.json',       // PHP
  'mix.exs',             // Elixir
  'pubspec.yaml',        // Dart / Flutter
  'CMakeLists.txt',      // C / C++
  'Makefile',            // C / generic
  'build.sbt',           // Scala
  'project.clj',         // Clojure
  '*.csproj',            // .NET (pattern — handled separately)
  '*.sln',               // .NET solution (pattern — handled separately)
];

// Plain manifest filenames (exact match, fast path).
const EXACT_MANIFESTS = MANIFEST_FILES.filter(f => !f.includes('*'));

// Source-file extensions: if a directory directly contains any of these it is
// very likely a code working dir even without a manifest (e.g. a scratch repo
// or a polyglot dir). Checked only at the start dir, not while walking up.
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.rb',
  '.php', '.ex', '.exs', '.dart', '.c', '.h',
  '.cpp', '.cc', '.hpp', '.cs', '.scala', '.clj', '.swift',
]);

// Corroborating (not required) repo/tracker markers.
const CORROBORATING_DIRS = ['.git', '.beads'];

function dirHasManifest(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (EXACT_MANIFESTS.includes(ent.name)) return true;
    // .NET project/solution files use a project-named prefix.
    if (ent.name.endsWith('.csproj') || ent.name.endsWith('.sln')) return true;
  }
  return false;
}

function dirHasSourceFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (SOURCE_EXTS.has(path.extname(ent.name).toLowerCase())) return true;
  }
  return false;
}

function dirHasCorroborating(dir) {
  for (const marker of CORROBORATING_DIRS) {
    try {
      if (fs.existsSync(path.join(dir, marker))) return true;
    } catch {}
  }
  return false;
}

// $HOME and the filesystem root are global, not project-scoped — never treat
// them as a code project root regardless of what markers they contain.
function isExcludedRoot(dir) {
  if (HOME_DIR && dir === HOME_DIR) return true;
  try {
    if (dir === path.parse(dir).root) return true;
  } catch {}
  return false;
}

// An Obsidian vault is NOT a code project, even though users routinely
// git-back their vault (auto-commit backups) and may have stray manifests in
// it. A directory containing `.obsidian/` is unambiguously a vault root;
// anything at or below it is vault content. Without this, findCodeRoot()
// latches onto the vault's `.git` corroborating signal and classifies EVERY
// vault session as a code session — exactly the failure the ~/code removal was
// meant to prevent for the primary (vault-centric) user.
function isInsideObsidianVault(startDir) {
  let dir;
  try {
    dir = path.resolve(startDir);
  } catch {
    return false;
  }
  const root = path.parse(dir).root;
  while (dir && dir !== root) {
    try {
      if (fs.existsSync(path.join(dir, '.obsidian'))) return true;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    if (fs.existsSync(path.join(root, '.obsidian'))) return true;
  } catch {}
  return false;
}

/**
 * Walk up from startDir. Return the first ancestor that looks like a project
 * root (manifest present, or a corroborating .git/.beads dir, or — at the
 * start dir only — bare source files). $HOME, the filesystem root, and any
 * path inside an Obsidian vault are excluded. Returns null if none found.
 */
function findCodeRoot(startDir) {
  if (!startDir) return null;
  let dir;
  try {
    dir = path.resolve(startDir);
  } catch {
    return null;
  }

  // An Obsidian vault (even a git-backed one) is never a code project.
  // Short-circuit before any manifest/corroborating check so the vault's
  // own `.git`/stray manifests can't classify a vault session as code.
  if (isInsideObsidianVault(dir)) return null;

  // Start dir gets the most permissive check (bare source files count here),
  // unless it is $HOME / fs root (a stray package.json in $HOME is not a
  // project worth tracking).
  if (!isExcludedRoot(dir)) {
    if (dirHasManifest(dir) || dirHasCorroborating(dir)) return dir;
    if (dirHasSourceFiles(dir)) return dir;
  }

  const root = path.parse(dir).root;
  let cur = path.dirname(dir);
  while (cur && cur !== root) {
    if (!isExcludedRoot(cur) && (dirHasManifest(cur) || dirHasCorroborating(cur))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function isCodeContext(startDir) {
  return findCodeRoot(startDir) !== null;
}

/**
 * Find the nearest ancestor (inclusive) that contains `marker`, EXCLUDING
 * $HOME and the filesystem root. Global markers live in $HOME — e.g.
 * `bd init --shared-server` drops a global `.beads/`, and a user may keep a
 * dotfiles `.git` in $HOME. Without excluding $HOME, every per-project check
 * would walk up, hit the global one, and wrongly conclude the project itself
 * is initialized. Returns the dir, or null if none below $HOME.
 */
function findMarkerRoot(startDir, marker) {
  if (!startDir) return null;
  let dir;
  try {
    dir = path.resolve(startDir);
  } catch {
    return null;
  }
  const root = path.parse(dir).root;
  while (dir && dir !== root) {
    if (!isExcludedRoot(dir)) {
      try {
        if (fs.existsSync(path.join(dir, marker))) return dir;
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Nearest ancestor with `.beads/`, excluding the global ~/.beads.
function findBeadsRoot(startDir) {
  return findMarkerRoot(startDir, '.beads');
}

// Nearest ancestor with `.git`, excluding a dotfiles ~/.git.
function findGitRoot(startDir) {
  return findMarkerRoot(startDir, '.git');
}

// ── Session-anchored working directory ───────────────────────────────────────

// Tiny per-session cache: { "<session_id>": "<first-seen cwd>" }. The first
// hook of a session (SessionStart) writes the anchor; every later hook reads
// it. Bounded so it can't grow without limit across many sessions.
const ANCHOR_FILE = (() => {
  try {
    return path.join(os.homedir(), '.claude', 'brainy-session-anchor.json');
  } catch {
    return null;
  }
})();
const ANCHOR_MAX = 200;

function readAnchors() {
  if (!ANCHOR_FILE) return {};
  try {
    const j = JSON.parse(fs.readFileSync(ANCHOR_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeAnchors(map) {
  if (!ANCHOR_FILE) return;
  try {
    // Cap size: drop oldest insertion-order keys if over the limit.
    const keys = Object.keys(map);
    if (keys.length > ANCHOR_MAX) {
      for (const k of keys.slice(0, keys.length - ANCHOR_MAX)) delete map[k];
    }
    fs.mkdirSync(path.dirname(ANCHOR_FILE), { recursive: true });
    fs.writeFileSync(ANCHOR_FILE, JSON.stringify(map));
  } catch {}
}

/**
 * Resolve the STABLE session working directory from hook stdin.
 *
 * The first time a session_id is seen, the supplied cwd is recorded as that
 * session's anchor (this is SessionStart, where cwd is the true session home).
 * Every later hook in the same session gets that same anchor back, regardless
 * of where the per-event cwd has since wandered.
 *
 * Falls back to the event cwd (or process.cwd()) when no session_id is present
 * (e.g. self-test / manual invocation).
 */
function sessionDir(stdin) {
  const data = stdin && typeof stdin === 'object' ? stdin : {};
  const eventCwd = data.cwd || process.cwd();
  const sid = data.session_id;
  if (!sid) return eventCwd;

  const anchors = readAnchors();
  const existing = anchors[sid];
  if (existing && typeof existing === 'string') {
    return existing;
  }
  // First hook for this session — anchor on the current (session-home) cwd.
  anchors[sid] = eventCwd;
  writeAnchors(anchors);
  return eventCwd;
}

/**
 * Is the SESSION (not this individual event) a code context?
 * Resolves the stable session dir, then applies structural detection.
 */
function isSessionCodeContext(stdin) {
  return findCodeRoot(sessionDir(stdin)) !== null;
}

module.exports = {
  findCodeRoot,
  findBeadsRoot,
  findGitRoot,
  isCodeContext,
  sessionDir,
  isSessionCodeContext,
};
