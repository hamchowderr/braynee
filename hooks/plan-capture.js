#!/usr/bin/env node
'use strict';

// plan-capture.js
// Hook: PostToolUse (ExitPlanMode) — when a plan is approved, persist it to
// the vault as a first-class artifact under "2. Areas/Plans/" so plans are
// recallable like sessions/transcripts (beads cp-prl). Mirrors the
// session-export-qmd.js pattern; reuses the shared qmd-reindex lib (cp-8xq)
// so the new plan note is searchable immediately (BM25) with embeddings
// self-healing on the throttled detached path.

const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const reindex = require(path.join(__dirname, 'lib', 'qmd-reindex.js'));

const HOOK = 'plan-capture';

const { getVaultRoot } = require(path.join(__dirname, '..', 'scripts', 'lib', 'vault-root.js'));
const VAULT_DIR = getVaultRoot();
const PLANS_DIR = path.join(VAULT_DIR, '2. Areas', 'Plans');
const QMD_WRAPPER = path.join(__dirname, '..', 'scripts', 'qmd-wrapper.mjs');

function slugify(s) {
  return String(s || '')
    .trim()
    .replace(/[^\w-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'plan';
}

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (err) {
  log.error(HOOK, `failed to read stdin: ${err.message}`);
  process.exit(0);
}

// hooks.json scopes us to ExitPlanMode, but stay defensive.
if (input.tool_name !== 'ExitPlanMode') process.exit(0);

const plan = ((input.tool_input || {}).plan || '').trim();
if (!plan) {
  log.info(HOOK, 'skipped: empty plan');
  process.exit(0);
}

const cwd = input.cwd || process.cwd();
const project = path.basename(cwd) || 'unknown';
const sessionId = input.session_id || '';
const sidPrefix = sessionId.slice(0, 8) || 'nosid000';

const now = new Date();
const date = now.toISOString().split('T')[0];
// HHMMSS keeps multiple plans from the same session distinct (each plan is
// its own decision) instead of clobbering like the per-session transcript.
const hhmmss = now.toTimeString().slice(0, 8).replace(/:/g, '');
const slug = slugify(project);
const filename = `${date}-${hhmmss}-${slug}.md`;
const filepath = path.join(PLANS_DIR, filename);

const fm = [
  '---',
  'type: plan',
  `session_id: "${sessionId}"`,
  `project_folder: "${project}"`,
  `date: ${date}`,
  `created: ${now.toISOString()}`,
  'tags:\n  - plan',
  '---',
  '',
  `# Plan — ${date} — ${project}`,
  `Project: \`${project}\` | Session: \`${sidPrefix}\` | Captured from Claude Code plan mode`,
  '',
  plan,
  '',
].join('\n');

try {
  if (!fs.existsSync(PLANS_DIR)) fs.mkdirSync(PLANS_DIR, { recursive: true });
  fs.writeFileSync(filepath, fm, 'utf8');
} catch (err) {
  log.error(HOOK, `failed to write plan note: ${err.message}`);
  process.exit(0); // never block the tool flow
}

// Reindex: cheap BM25 now (single-flight), embed throttled + detached.
const kw = reindex.runKeywordUpdate(QMD_WRAPPER);
const em = reindex.scheduleEmbed();

log.info(
  HOOK,
  `captured ${filename} (${plan.length} chars); qmd update=${kw.ran ? 'ok' : kw.reason}, embed=${em.scheduled ? 'scheduled' : em.reason}`
);

process.stdout.write(
  JSON.stringify({
    additionalContext: `Plan captured to vault: "2. Areas/Plans/${filename}" (recallable via QMD / braynee:recall). No manual note needed.`,
  })
);
process.exit(0);
