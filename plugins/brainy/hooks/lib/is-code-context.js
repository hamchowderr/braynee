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
// Exports:
//   findCodeRoot(startDir)   → absolute path of the detected project root, or null
//   isCodeContext(startDir)  → boolean (findCodeRoot !== null)
//
// Pure, synchronous, no external deps. Safe to require from any hook.

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

/**
 * Walk up from startDir. Return the first ancestor that looks like a project
 * root (manifest present, or a corroborating .git/.beads dir, or — at the
 * start dir only — bare source files). $HOME and the filesystem root are
 * excluded. Returns null if none found.
 */
function findCodeRoot(startDir) {
  if (!startDir) return null;
  let dir;
  try {
    dir = path.resolve(startDir);
  } catch {
    return null;
  }

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

module.exports = { findCodeRoot, isCodeContext };
