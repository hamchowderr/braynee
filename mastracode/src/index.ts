import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineMastraCodePlugin } from 'mastracode/plugin';
import { vaultInstructions } from '../../scripts/lib/vault-instructions.mjs';

/**
 * Mastra Code adapter for braynee.
 *
 * The manifest (.mastracode-plugin.json) sits at the braynee repo root, so the
 * plugin ROOT is the repo itself. That is deliberate: Mastra Code discovers a
 * plugin's skills at `<pluginRoot>/skills`, which is already braynee's real
 * skills directory. No copies, no symlinks, no build step, and the Claude Code
 * and Mastra Code surfaces cannot drift apart.
 *
 * Beware the two different directories:
 *   pluginRoot  = <repo>              -> where skills/ and commands/ are found
 *   ctx.pluginDir = <repo>/mastracode/src -> path.dirname(entryPath), NOT the root
 * Verified in @mastra/code-sdk loader.ts.
 */

const requireFromHere = createRequire(import.meta.url);

/** Resolve the braynee repo root from the entry directory (`<repo>/mastracode/src`). */
function brayneeRootFrom(pluginDir: string): string {
  return path.resolve(pluginDir, '..', '..');
}

/**
 * Instructions that exist only to close a gap between the two hosts.
 *
 * On Claude Code, braynee's setup writes `autoMemoryDirectory` into the Claude
 * Code settings, so the memory index is injected automatically every session.
 * Mastra Code has no equivalent setting, so the agent has to be told to read it.
 *
 * This deliberately does NOT live in scripts/lib/vault-instructions.mjs: that
 * module is shared with the Claude Code UserPromptSubmit hook and must stay
 * byte-identical across hosts. Host-compensating text belongs here instead.
 *
 * Emitted only when the index actually exists — never instruct an agent to read
 * a file that is not there.
 */
function hostGapInstructions(): string {
  let vaultRoot: string;
  try {
    // braynee's own resolver, so the vault is found the same way every entry point finds it.
    const { getVaultRoot } = requireFromHere('../../scripts/lib/vault-root.js') as {
      getVaultRoot(): string;
    };
    vaultRoot = getVaultRoot();
  } catch {
    return '';
  }

  const memoryIndex = path.join(vaultRoot, '2. Areas', 'Claude Memory', 'MEMORY.md');
  if (!fs.existsSync(memoryIndex)) return '';

  return (
    `Persistent memory: read "${memoryIndex}" at the start of any non-trivial task. ` +
    'It is a one-line index into per-fact notes in the same folder; open a topic file for detail. ' +
    'Claude Code injects this index automatically, Mastra Code does not, so read it yourself.'
  );
}

/**
 * Where braynee lives on disk, stated so the model can act on it.
 *
 * The generated /braynee:* commands tell a subagent to read its playbook from
 * `agents/<name>.md`, which only works if something says where that is. Claude
 * Code expands ${CLAUDE_PLUGIN_ROOT} for this; Mastra Code has no such token, so
 * the path is resolved here at load time and stated plainly.
 */
function locationInstructions(pluginDir: string): string {
  const root = brayneeRootFrom(pluginDir);
  return (
    `braynee is installed at "${root}". Its agent playbooks are in ` +
    `"${path.join(root, 'agents')}" — the /braynee:* commands delegate to a subagent and ` +
    'expect it to read the matching playbook from there before doing anything.'
  );
}

export default defineMastraCodePlugin({
  id: 'braynee',
  name: 'Braynee',
  description:
    'Turns Mastra Code into your second brain: Obsidian PARA vault, QMD search over every past ' +
    'session, beads task tracking, and the daily workflow skills.',

  // Mastra Code cannot inject context from hooks — its TUI never reads a hook's
  // additionalContext — so the vault search mandate has to arrive as plugin
  // instructions. Same generator the Claude Code UserPromptSubmit hook uses, so
  // the two hosts stay byte-identical.
  instructions: ctx =>
    [
      vaultInstructions({ brayneeRoot: brayneeRootFrom(ctx.pluginDir) }),
      hostGapInstructions(),
      locationInstructions(ctx.pluginDir),
    ]
      .filter(Boolean)
      .join('\n\n'),
});
