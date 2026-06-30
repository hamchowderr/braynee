// prd-seed-gate.js
// Hook: PreToolUse (Bash) — warn when `prd-seed.mjs` runs against a PRD that still
// has unfilled MVP Definition placeholders or unresolved Open Questions, so a
// half-scoped PRD isn't seeded into half-baked issues. Pairs with the /braynee:prd
// interview (cp-uqy): the interview fills the PRD, this catches a PRD that skipped it.
//
// WARN by default (open questions can be intentional — exit 0 + additionalContext);
// set BRAYNEE_PRD_SEED_GATE=block to hard-block (exit 2) instead.
//
// Self-gates in JS (never the version-unreliable `if` field): any command that isn't
// a prd-seed.mjs invocation exits 0 immediately, before any filesystem read.

const fs = require('fs');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const HOOK = 'prd-seed-gate';

// ── Pure helpers (exported for the unit test) ────────────────────────────────

// Return { name } when the command invokes prd-seed.mjs with a PRD name, else null.
// Matches prd-seed.mjs ONLY (not prd-seed-core.js / prd-seed-gate.js).
function parsePrdSeedCommand(command) {
  if (!command || !/prd-seed\.mjs/.test(command)) return null;
  const after = command.split(/prd-seed\.mjs/)[1] || '';
  const rest = after.replace(/^["']/, '').trim(); // drop a closing quote on the script path
  if (!rest || rest.startsWith('-')) return null;  // no name, or a flag came first
  const q = rest.match(/^(['"])(.*?)\1/);
  const name = q ? q[2] : rest.split(/\s+/)[0];
  return name ? { name } : null;
}

// Body of "## <heading>" up to the next "## " (or EOF). '' if the heading is absent.
function sectionBody(md, heading) {
  const re = new RegExp('^##\\s+' + heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'mi');
  const m = re.exec(md || '');
  if (!m) return '';
  const start = m.index + m[0].length;
  const rel = md.slice(start).search(/^##\s+/m);
  return rel === -1 ? md.slice(start) : md.slice(start, start + rel);
}

// Inspect a PRD's markdown → { mvpPlaceholders, openQuestions }.
// A clean PRD returns { 0, 0 } (no gate friction).
function findPrdGaps(md) {
  const mvp = sectionBody(md, 'MVP Definition');
  let mvpPlaceholders = 0;
  if (!mvp.trim()) {
    mvpPlaceholders += 1; // no MVP Definition at all → not seedable
  } else {
    mvpPlaceholders += (mvp.match(/<[^>\n]+>/g) || []).length;            // <angle placeholders>
    mvpPlaceholders += (mvp.match(/^\s*(?:\d+\.\s*)?\.\.\.\s*$/mg) || []).length; // "1. ..." / bare "..."
    mvpPlaceholders += (mvp.match(/…/g) || []).length;                    // U+2026 ellipsis
  }

  const risks = sectionBody(md, 'Risks & Open Questions');
  let openQuestions = 0;
  for (const ln of (risks ? risks.split('\n') : [])) {
    const oq = ln.match(/^\s*[-*]\s*\*\*Open question:\*\*\s*(.*)$/i);
    if (oq) {
      const body = oq[1].trim();
      if (body && body !== '…' && body !== '...') openQuestions++;
    }
  }
  return { mvpPlaceholders, openQuestions };
}

module.exports = { parsePrdSeedCommand, sectionBody, findPrdGaps };

// ── Hook body (only when run directly) ───────────────────────────────────────
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { input += c; });
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(input);
      const command = data.tool_input?.command || '';
      const parsed = parsePrdSeedCommand(command);
      if (!parsed) process.exit(0); // not a prd-seed call → silent

      let vaultRoot;
      try {
        const { getVaultRoot } = require(path.join(__dirname, '..', 'scripts', 'lib', 'vault-root.js'));
        vaultRoot = getVaultRoot();
      } catch { process.exit(0); }
      if (!vaultRoot) process.exit(0);

      const slug = parsed.name.replace(/[^A-Za-z0-9-]/g, '-');
      const prdPath = path.join(vaultRoot, '2. Areas', 'Product Manager', 'PRDs', slug + '.md');
      if (!fs.existsSync(prdPath)) process.exit(0); // can't inspect → don't get in the way

      const { mvpPlaceholders, openQuestions } = findPrdGaps(fs.readFileSync(prdPath, 'utf8'));
      if (mvpPlaceholders === 0 && openQuestions === 0) process.exit(0); // clean → no friction

      const bits = [];
      if (mvpPlaceholders > 0) bits.push(`${mvpPlaceholders} unfilled MVP Definition placeholder${mvpPlaceholders !== 1 ? 's' : ''} (Auth / Freemium / Core Features)`);
      if (openQuestions > 0) bits.push(`${openQuestions} unresolved Open Question${openQuestions !== 1 ? 's' : ''}`);
      const msg = `PRD "${parsed.name}" still has ${bits.join(' and ')}. Seeding now turns a half-scoped PRD into half-baked issues — resolve them (or run the /braynee:prd interview) first. Open questions can be intentional, so this is a warning, not a block.`;

      if (process.env.BRAYNEE_PRD_SEED_GATE === 'block') {
        log.warn(HOOK, `blocked prd-seed of ${parsed.name}: ${bits.join('; ')}`);
        process.stderr.write('BLOCKED: ' + msg + ' (set by BRAYNEE_PRD_SEED_GATE=block)');
        process.exit(2);
      }
      log.warn(HOOK, `warned prd-seed of ${parsed.name}: ${bits.join('; ')}`);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg },
      }));
      process.exit(0);
    } catch (e) {
      log.error(HOOK, `crash: ${e.message}`);
      process.exit(0);
    }
  });
}
