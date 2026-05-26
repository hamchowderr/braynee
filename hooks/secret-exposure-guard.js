// secret-exposure-guard.js
// Hook: PreToolUse (Bash + Write) — keeps secret VALUES out of the transcript.
// Self-gating (no `if` field — see CLAUDE.md): matches inside the JS, exits 0 early on a non-match.
//
// Two guards, one principle ("secret values flow user -> vault -> process env, never the chat"):
//   1. Bash  — DENY value-printing secrets-manager commands (the exposure path):
//                infisical secrets / secrets get / export, doppler secrets get|download,
//                vault kv get / vault read, op item get / op read.
//              ALLOWS injection commands (`infisical run`, `doppler run`) and writes
//              (`infisical secrets set`) — those never print a value.
//   2. Write — DENY writing real API keys/tokens into a .env file (placeholders pass).
//
// Exit 2 = block (stderr to Claude), exit 0 = allow.
// Opt-out for a deliberate one-off read: env BRAYNEE_ALLOW_SECRET_READS=1.
// Universality: the Bash guard only fires when a known manager command matches, so it is
// inert for users of any other (or no) secrets manager — nothing user-specific is baked in.

const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'secret-exposure-guard';
const ALLOW_READS = process.env.BRAYNEE_ALLOW_SECRET_READS === '1';

// --- Bash: commands that PRINT secret values to stdout (i.e. into the transcript) ---
// Each entry: [regex, allow-regex?] — if allow-regex matches, the command is permitted.
const VALUE_PRINTING = [
  // Infisical: `secrets`/`secrets get`/`export` dump values; `run`/`set`/`init`/`login`/`scan` do not.
  { re: /\binfisical\s+secrets\s+get\b/i, label: 'infisical secrets get' },
  { re: /\binfisical\s+export\b/i, label: 'infisical export' },
  // bare `infisical secrets` (list with values) — but allow the safe subcommands
  { re: /\binfisical\s+secrets\b/i, allow: /\binfisical\s+secrets\s+(set|delete|folders)\b/i, label: 'infisical secrets (list)' },
  // Doppler
  { re: /\bdoppler\s+secrets\s+(get|download)\b/i, label: 'doppler secrets get/download' },
  { re: /\bdoppler\s+secrets\b/i, allow: /\bdoppler\s+secrets\s+(set|delete|upload)\b/i, label: 'doppler secrets (list)' },
  // HashiCorp Vault
  { re: /\bvault\s+kv\s+get\b/i, label: 'vault kv get' },
  { re: /\bvault\s+read\b/i, label: 'vault read' },
  // 1Password
  { re: /\bop\s+read\b/i, label: 'op read' },
  { re: /\bop\s+item\s+get\b/i, allow: /--format\s*=?\s*json[^|]*\|\s*op\b/i, label: 'op item get' },
];

// --- Write: patterns that suggest a REAL secret (not a placeholder) in a .env file ---
const SECRET_PATTERNS = [
  /sk-ant-[a-zA-Z0-9\-_]{20,}/,                         // Anthropic
  /sk-[a-zA-Z0-9]{48,}/,                                // OpenAI
  /AKIA[A-Z0-9]{16}/,                                   // AWS access key id
  /(?:aws_secret_access_key|aws_secret)\s*=\s*[A-Za-z0-9\/+]{30,}/i,
  /sk_live_[a-zA-Z0-9]{20,}/, /rk_live_[a-zA-Z0-9]{20,}/, // Stripe live
  /eyJ[a-zA-Z0-9\-_]{40,}\.[a-zA-Z0-9\-_]{40,}\.[a-zA-Z0-9\-_]{20,}/, // JWT / service role
  /ghp_[a-zA-Z0-9]{36}/, /github_pat_[a-zA-Z0-9_]{82}/,  // GitHub PATs
  /AC[a-f0-9]{32}/,                                      // Twilio SID
  /=\s*[a-f0-9]{40,}(?!\s*#[^\n]*placeholder)/i,         // generic long hex
  /=\s*[A-Za-z0-9\/+]{50,}={0,2}(?!\s*#[^\n]*placeholder)/, // generic long base64
];
const PLACEHOLDER_PATTERNS = [
  /your[_-][a-z_]+[_-]here/i, /YOUR_[A-Z_]+_HERE/, /replace[_-]me/i, /placeholder/i,
  /todo/i, /example[_-]/i, /test[_-]key/i, /xxx+/i, /\.\.\./, /<[^>]+>/, /\$\{[^}]+\}/,
];

function blockBash(command) {
  for (const { re, allow, label } of VALUE_PRINTING) {
    if (re.test(command) && !(allow && allow.test(command))) {
      return label;
    }
  }
  return null;
}

function blockEnvWrite(filePath, content) {
  const basename = path.basename(filePath || '');
  const isEnvFile = basename === '.env' || basename.startsWith('.env.');
  if (!isEnvFile) return null;
  const suspicious = [];
  for (const line of String(content).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (PLACEHOLDER_PATTERNS.some(p => p.test(trimmed))) continue;
    const keyMatch = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=/i);
    if (keyMatch && SECRET_PATTERNS.some(p => p.test(trimmed))) suspicious.push(keyMatch[1]);
  }
  return suspicious.length ? suspicious : null;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const ti = data.tool_input || {};

    // ---- Bash: value-printing secrets command ----
    if (typeof ti.command === 'string' && ti.command) {
      const hit = blockBash(ti.command);
      if (hit) {
        if (ALLOW_READS) { process.exit(0); }
        log.warn(HOOK, `blocked value-printing command: ${hit}`);
        process.stderr.write(
          `BLOCKED: \`${hit}\` prints secret VALUES to stdout — they would land in the transcript, defeating the secrets manager. ` +
          `Inject at runtime instead (e.g. \`infisical run --recursive --silent -- <cmd>\`). ` +
          `To confirm a secret exists, print a MASK only. Set BRAYNEE_ALLOW_SECRET_READS=1 for a deliberate one-off.`
        );
        process.exit(2);
      }
      process.exit(0);
    }

    // ---- Write: real secret into a .env file ----
    if (typeof ti.file_path === 'string') {
      const keys = blockEnvWrite(ti.file_path, ti.content || '');
      if (keys) {
        log.warn(HOOK, `blocked .env write with real secrets: ${keys.join(', ')}`);
        process.stderr.write(
          `BLOCKED: this .env write appears to contain real secrets in: ${keys.join(', ')}. ` +
          `Use placeholders (YOUR_KEY_HERE) and inject real values at runtime. Never write real keys to disk.`
        );
        process.exit(2);
      }
      process.exit(0);
    }

    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
