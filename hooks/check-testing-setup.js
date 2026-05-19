// check-testing-setup.js
// Hook: SessionStart — Nudge users to wire up testing infrastructure when
// it's missing in a code project. Non-blocking; no auto-install (testing
// has too many project-specific decisions to safely automate).
//
// Detects missing:
//   - Vitest (vitest dep + vitest.config.*)
//   - Playwright (playwright dep + playwright.config.*)
//   - AIMock (@copilotkit/aimock or aimock-cli dep + ai-fixtures/aimock dir)
//
// Output is markdown injected into context so Claude can offer to set them up.

const fs = require('fs');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { findCodeRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

const HOOK = 'check-testing-setup';

function fileExists(p) { try { return fs.existsSync(p); } catch { return false; } }

function checkProject(cwd) {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fileExists(pkgPath)) return null;
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch { return null; }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const has = {
    vitest: !!deps.vitest && (
      fileExists(path.join(cwd, 'vitest.config.ts')) ||
      fileExists(path.join(cwd, 'vitest.config.js')) ||
      fileExists(path.join(cwd, 'vitest.config.mjs'))
    ),
    playwright: (!!deps.playwright || !!deps['@playwright/test']) && (
      fileExists(path.join(cwd, 'playwright.config.ts')) ||
      fileExists(path.join(cwd, 'playwright.config.js'))
    ),
    aimock: !!deps['@copilotkit/aimock'] || !!deps['@copilotkit/llmock'] || !!deps['aimock-cli'],
  };
  return has;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }

    // F-3.2a + F-3.2b: act only in a code context, detected structurally on
    // the SESSION's working dir — not a ~/code prefix. findCodeRoot already
    // resolves to the project root, which is where package.json lives.
    const cwd = findCodeRoot(sessionDir(data));
    if (!cwd) process.exit(0);
    if (path.basename(cwd).toLowerCase() === 'workspace') process.exit(0);

    const has = checkProject(cwd);
    if (!has) process.exit(0);

    const missing = Object.entries(has).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length === 0) {
      log.info(HOOK, 'all testing infra present');
      process.exit(0);
    }

    log.info(HOOK, `missing: ${missing.join(',')}`);
    const lines = [
      '# Testing setup check',
      '',
      `\`${path.basename(cwd)}\` is missing: **${missing.join(', ')}**`,
      '',
      'Recommended testing stack (Vitest + Playwright + AIMock — see [docs/testing-stack.md](https://github.com/hamchowderr/claude-plugins/blob/master/plugins/brainy/docs/testing-stack.md)):',
      '',
    ];
    if (!has.vitest) lines.push('```bash\nnpm i -D vitest @vitest/ui\nnpx vitest --version\n```\nDocs: https://vitest.dev/guide/cli', '');
    if (!has.playwright) lines.push('```bash\nnpm i -D @playwright/test\nnpx playwright install\n```\nDocs: https://playwright.dev/docs/getting-started-cli', '');
    if (!has.aimock) lines.push('```bash\nnpm i -D @copilotkit/aimock\nnpx aimock-cli init\n```\nDocs: https://aimock.copilotkit.dev/aimock-cli/', '');
    lines.push('Wire `package.json` scripts: `test` (vitest), `test:e2e` (playwright), `test:ai` (with AIMock running). CI should run all three on PR.');
    process.stdout.write(lines.join('\n') + '\n');
    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
