#!/usr/bin/env node
// mirror-llms-docs.mjs — Put docs source-of-truth in a target dir using the
// INDEX + CURATED-COPIES model (NOT a full site mirror).
//
// A site's root llms.txt is a curated link-map of its docs. Save that as a
// navigable index; the agent fetches exact pages on demand; you copy only the
// handful of pages you use constantly. Built-in `fetch` — no curl, no
// Firecrawl/Infisical, zero deps, cross-platform (Windows-first).
//
// Usage:
//   node mirror-llms-docs.mjs index <domain> <target-dir> ["Note Name"]
//       Fetch https://<domain>/llms.txt and save it as the index note.
//       Example:
//         node mirror-llms-docs.mjs index mastra.ai "…/AI/Mastra" "Mastra Docs Index"
//
//   node mirror-llms-docs.mjs pages <target-dir> <clean-page-url> [<clean-page-url> ...]
//       Copy each clean-markdown page URL verbatim into <target-dir>.
//       Pass the site's clean per-page route:
//         Mastra:  https://mastra.ai/docs/agents/overview.md   (append .md)
//         Docker:  https://docs.docker.com/engine/install.md   (append .md)
//
// GENERIC: takes target-dir as an argument and hardcodes no vault path or
// owner-specific folder — braynee ships zero user-specific data.
// See the `braynee:docs-lookup` skill and the [[llms-docs-mirror-pattern]] memory.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function stamp() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// Signal fatal errors by throwing, never `process.exit()`. Node's global fetch
// (undici) keeps sockets open briefly; calling process.exit() mid-close crashes
// with a libuv assertion on Windows. We set process.exitCode and let the event
// loop drain naturally instead (verified: the success paths already exit promptly).
class ExitError extends Error {
  constructor(msg, code = 1) {
    super(msg);
    this.code = code;
  }
}

function die(msg, code = 1) {
  throw new ExitError(msg, code);
}

const USAGE = `Usage:
  node mirror-llms-docs.mjs index <domain> <target-dir> ["Note Name"]
  node mirror-llms-docs.mjs pages <target-dir> <clean-page-url> [<clean-page-url> ...]`;

async function fetchText(url) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'braynee-mirror-llms-docs/1.0' },
    });
  } catch (err) {
    throw new Error(`network error fetching ${url}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return res.text();
}

// slug: strip protocol+domain, strip trailing /llms.txt or .md, slashes -> dashes.
function slugFromUrl(url) {
  const slug = url
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\/llms\.txt$/, '')
    .replace(/\.md$/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\//g, '-');
  return slug || 'index';
}

async function cmdIndex(args) {
  const domain = args[0];
  const target = args[1];
  if (!domain) die(`domain required (e.g. mastra.ai)\n${USAGE}`);
  if (!target) die(`target dir required\n${USAGE}`);
  const name = args[2] || `${domain} Docs Index`;

  fs.mkdirSync(target, { recursive: true });
  const outPath = path.join(target, `${name}.md`);
  const url = `https://${domain}/llms.txt`;

  process.stdout.write(`==> Fetching ${url}\n`);
  let body;
  try {
    body = await fetchText(url);
  } catch (err) {
    die(`could not fetch llms.txt — ${err.message}`);
  }

  const fm =
    `---\n` +
    `name: ${name}\n` +
    `description: "Navigable index of ${domain} docs (root llms.txt) — every page as a direct link. Agent fetches exact pages on demand; NOT a local mirror."\n` +
    `type: reference\n` +
    `source: https://${domain}/llms.txt\n` +
    `refreshed: ${stamp()}\n` +
    `tags: [reference, index, llms-txt]\n` +
    `---\n\n` +
    `> Root llms.txt link-map. Fetch any page on demand for clean markdown. NOT a full mirror.\n` +
    `> Refresh: \`node mirror-llms-docs.mjs index ${domain} "${target}" "${name}"\`\n\n---\n\n` +
    `${body}\n`;

  fs.writeFileSync(outPath, fm, 'utf8');
  const lines = fm.split('\n').length;
  process.stdout.write(`==> Wrote index: ${outPath} (${lines} lines)\n`);
}

async function cmdPages(args) {
  const target = args[0];
  const urls = args.slice(1);
  if (!target) die(`target dir required\n${USAGE}`);
  if (urls.length < 1) die(`pass at least one clean-page URL\n${USAGE}`);

  fs.mkdirSync(target, { recursive: true });
  let ok = 0;
  let failed = 0;
  for (const url of urls) {
    const slug = slugFromUrl(url);
    const outPath = path.join(target, `${slug}.md`);
    process.stdout.write(`==> ${url} -> ${slug}.md\n`);
    let body;
    try {
      body = await fetchText(url);
    } catch (err) {
      process.stderr.write(`  FAIL: ${err.message}\n`);
      failed++;
      continue;
    }
    const doc =
      `---\nsource: ${url}\nfetched: ${stamp()}\ntype: reference\ntags: [reference, verbatim-copy]\n---\n\n` +
      `> Verbatim copy of ${url} — do not hand-edit; re-fetch to refresh.\n\n---\n\n` +
      `${body}\n`;
    fs.writeFileSync(outPath, doc, 'utf8');
    ok++;
  }
  process.stdout.write(`==> Done: ${ok} copied, ${failed} failed -> ${target}\n`);
  if (ok === 0) process.exitCode = 1;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'index':
      await cmdIndex(rest);
      break;
    case 'pages':
      await cmdPages(rest);
      break;
    case '-h':
    case '--help':
    case 'help':
    case undefined:
      process.stdout.write(`${USAGE}\n`);
      if (cmd === undefined) process.exitCode = 1;
      break;
    default:
      die(`Unknown command: ${cmd} (use 'index' or 'pages')\n${USAGE}`);
  }
}

main().catch((err) => {
  if (err.message) process.stderr.write(`ERROR: ${err.message}\n`);
  process.exitCode = err instanceof ExitError ? err.code : 1;
});
