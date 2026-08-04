// memory-reminder.js
// Hook: UserPromptSubmit — Injects a memory reminder with every message.
// This ensures Claude always knows it can search past sessions via vault-query and QMD,
// even deep into a session after compaction when CLAUDE.md instructions fade.
//
// Outputs to stdout = injected into Claude's context before processing the message.
//
// The text itself lives in scripts/lib/vault-instructions.mjs so the Claude Code
// and Mastra Code surfaces cannot drift. Mastra Code cannot inject context from a
// hook at all, so it consumes the same generator as plugin `instructions` instead.

const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'memory-reminder';
const BRAYNEE_ROOT = path.join(__dirname, '..');

(async () => {
  try {
    const { vaultInstructions } = await import(
      require('node:url').pathToFileURL(
        path.join(BRAYNEE_ROOT, 'scripts', 'lib', 'vault-instructions.mjs'),
      ).href
    );
    process.stdout.write(vaultInstructions({ brayneeRoot: BRAYNEE_ROOT }));
  } catch (err) {
    // Never break the user's turn over a reminder — but never swallow silently
    // either. Losing this reminder means the agent stops being told the vault is
    // searchable, which degrades quietly and is very hard to notice. The most
    // likely cause is scripts/lib/vault-instructions.mjs not being deployed
    // alongside hooks/ (it is a newer dependency of this hook).
    log.error(HOOK, `vault instructions unavailable, reminder not injected: ${err && err.message}`);
  }
  process.exit(0);
})();
