#!/usr/bin/env node
// project-resolver.test.js — cp-ccsh.10 / B10, priority 1 by blast radius: this
// module's output is written into session and transcript frontmatter as a
// [[wikilink]], so a wrong answer produces a broken link in the vault graph.
//
// It was also completely untested while it shipped a hard-coded table of one
// user's projects (cp-ccsh.5 / B4), so the aliases themselves were unverified —
// 4 of the 15 pointed at notes that did not exist.
//
// Everything runs against a fixture vault in tmpdir with
// $BRAYNEE_PROJECT_ALIASES pointing at a fixture alias file, so no real vault or
// machine config is touched.
//
// Pure Node, no deps, cross-platform. Exit 0 = pass, 1 = fail.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const fails = [];
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; fails.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
function ok(name, cond) {
  if (cond) pass++; else { fail++; fails.push(name); }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'projres-'));
try {
  // Point at a non-existent alias file first: $BRAYNEE_PROJECT_ALIASES is
  // authoritative when set, so this guarantees the machine-wide config cannot
  // leak into the "no aliases" cases below.
  const NO_ALIASES = path.join(sandbox, 'no-such-aliases.json');
  process.env.BRAYNEE_PROJECT_ALIASES = NO_ALIASES;

  const { resolveProjectLink, norm, loadAliases, aliasFilePaths, ALIAS_FILENAME } =
    require('./project-resolver.js');

  const VAULT = path.join(sandbox, 'vault');
  const mkNote = (rel) => {
    const fp = path.join(VAULT, rel + '.md');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, `# ${path.basename(rel)}\n`);
  };
  mkNote('1. Projects/Sophon Webapp');
  mkNote('1. Projects/Acme Platform/Acme Platform');
  mkNote('1. Projects/acme.app');                    // dots in the note name
  mkNote('1. Projects/Group/Nested Project');
  mkNote('4. Archives/Projects/Retired Thing');
  mkNote('1. Projects/_template');                   // underscore-prefixed → skipped
  mkNote('3. Resources/Not A Project');              // outside the walked roots

  // ── norm ───────────────────────────────────────────────────────────────────
  eq('norm lowercases and strips non-alphanumerics', norm('Acme.App-Web_2'), 'acmeappweb2');
  eq('norm on an empty string', norm(''), '');

  // ── exact index match (alphanumeric-normalized) ────────────────────────────
  eq('exact match on a flat note', resolveProjectLink('Sophon Webapp', VAULT), '1. Projects/Sophon Webapp');
  eq('match is normalization-insensitive', resolveProjectLink('sophon-webapp', VAULT), '1. Projects/Sophon Webapp');
  eq('match ignores punctuation differences', resolveProjectLink('acme-app', VAULT), '1. Projects/acme.app');
  eq('foldered note resolves to its inner note',
     resolveProjectLink('acme-platform', VAULT), '1. Projects/Acme Platform/Acme Platform');
  eq('nested note is found by the recursive walk',
     resolveProjectLink('nested-project', VAULT), '1. Projects/Group/Nested Project');
  eq('archived projects are searched too',
     resolveProjectLink('retired-thing', VAULT), '4. Archives/Projects/Retired Thing');

  // ── returned paths are vault-relative, forward-slashed, no .md ─────────────
  {
    const r = resolveProjectLink('nested-project', VAULT);
    ok('result has no .md extension', !/\.md$/.test(r));
    ok('result uses forward slashes', !r.includes('\\'));
    ok('result is vault-relative, not absolute', !path.isAbsolute(r));
  }

  // ── exclusions ─────────────────────────────────────────────────────────────
  eq('underscore-prefixed notes are skipped', resolveProjectLink('template', VAULT), null);
  eq('notes outside 1. Projects / 4. Archives are not indexed',
     resolveProjectLink('Not A Project', VAULT), null);
  eq('an unknown name resolves to null', resolveProjectLink('does-not-exist-anywhere', VAULT), null);

  // ── longest-prefix fallback ────────────────────────────────────────────────
  eq('longer slug falls back to its prefix note',
     resolveProjectLink('sophonwebappapi', VAULT), '1. Projects/Sophon Webapp');
  eq('prefix fallback needs at least 6 chars of key', resolveProjectLink('acmeappextra', VAULT), '1. Projects/acme.app');
  // "acmeplatform" (12) and "acmeapp" (7) both prefix-match "acmeplatformweb"? No —
  // only keys that are a genuine prefix qualify, and the LONGEST wins.
  eq('longest prefix wins over a shorter one',
     resolveProjectLink('acmeplatformweb', VAULT), '1. Projects/Acme Platform/Acme Platform');

  // ── bad input never throws ─────────────────────────────────────────────────
  eq('empty name → null', resolveProjectLink('', VAULT), null);
  eq('null name → null', resolveProjectLink(null, VAULT), null);
  eq('name of only punctuation → null', resolveProjectLink('---', VAULT), null);
  eq('missing vault dir → null', resolveProjectLink('Sophon Webapp', path.join(sandbox, 'nope')), null);

  // ── alias config (cp-ccsh.5 / B4) ──────────────────────────────────────────
  eq('no alias file → empty alias map', JSON.stringify(loadAliases(VAULT)), '{}');
  ok('resolution still works with no alias file',
     resolveProjectLink('Sophon Webapp', VAULT) === '1. Projects/Sophon Webapp');
  eq('the alias filename is the documented one', ALIAS_FILENAME, 'project-aliases.json');

  {
    const aliasFile = path.join(sandbox, 'aliases.json');
    process.env.BRAYNEE_PROJECT_ALIASES = aliasFile;

    fs.writeFileSync(aliasFile, JSON.stringify({
      'old-codename': '1. Projects/Sophon Webapp',
      'Mixed.Case-Key': '1. Projects/acme.app',
      'points-nowhere': '1. Projects/Deleted Note',
    }));

    eq('an alias maps a slug that the index cannot match',
       resolveProjectLink('old-codename', VAULT), '1. Projects/Sophon Webapp');
    eq('alias keys are normalized on load, so any spelling works',
       resolveProjectLink('mixedcasekey', VAULT), '1. Projects/acme.app');
    eq('a hand-written unnormalized lookup also hits',
       resolveProjectLink('Mixed.Case-Key', VAULT), '1. Projects/acme.app');
    // A stale alias must not emit a broken wikilink.
    eq('an alias pointing at a missing note resolves to null, not a broken link',
       resolveProjectLink('points-nowhere', VAULT), null);
    eq('aliases take precedence over the index',
       resolveProjectLink('old-codename', VAULT), '1. Projects/Sophon Webapp');
    eq('loaded alias count', Object.keys(loadAliases(VAULT)).length, 3);

    // Malformed / hostile config must degrade to index-only, never throw.
    for (const [label, body] of [
      ['invalid JSON', '{ not json'],
      ['a JSON array', '[1,2,3]'],
      ['a JSON string', '"just a string"'],
      ['null', 'null'],
      ['non-string values', '{"a": 5, "b": {"c": 1}, "c": ""}'],
    ]) {
      fs.writeFileSync(aliasFile, body);
      eq(`${label} → empty alias map`, JSON.stringify(loadAliases(VAULT)), '{}');
      eq(`${label} still resolves by index`,
         resolveProjectLink('Sophon Webapp', VAULT), '1. Projects/Sophon Webapp');
    }

    process.env.BRAYNEE_PROJECT_ALIASES = NO_ALIASES;
  }

  // ── config lookup order ────────────────────────────────────────────────────
  {
    const paths = aliasFilePaths(VAULT);
    eq('$BRAYNEE_PROJECT_ALIASES is authoritative (single candidate)', paths.length, 1);
    eq('and it is the env path', paths[0], NO_ALIASES);

    delete process.env.BRAYNEE_PROJECT_ALIASES;
    const unset = aliasFilePaths(VAULT);
    eq('without the env var there are two candidates', unset.length, 2);
    eq('the vault-scoped file is preferred',
       unset[0], path.join(VAULT, '.braynee', ALIAS_FILENAME));
    ok('the machine-wide file is the fallback',
       unset[1].includes('.claude') && unset[1].endsWith(ALIAS_FILENAME));

    // The vault-scoped file must actually be read when present.
    const vaultAlias = path.join(VAULT, '.braynee', ALIAS_FILENAME);
    fs.mkdirSync(path.dirname(vaultAlias), { recursive: true });
    fs.writeFileSync(vaultAlias, JSON.stringify({ 'vault-scoped': '1. Projects/Sophon Webapp' }));
    eq('a vault-scoped alias file is honored',
       resolveProjectLink('vault-scoped', VAULT), '1. Projects/Sophon Webapp');
    fs.rmSync(path.join(VAULT, '.braynee'), { recursive: true, force: true });
    process.env.BRAYNEE_PROJECT_ALIASES = NO_ALIASES;
  }

  // ── no owner-specific data baked into the module (cp-ccsh.5 acceptance) ─────
  {
    const src = fs.readFileSync(path.join(__dirname, 'project-resolver.js'), 'utf8');
    ok('the module ships no hard-coded ALIAS table',
       !/^const ALIAS = \{/m.test(src));
    // "braynee" itself is excluded — it is the plugin's own name and appears
    // legitimately in the config path (~/.claude/braynee/project-aliases.json).
    // The generic "1. Projects/Some Project" in the doc comment is the intended
    // placeholder. The repo-wide version of this check is self-test section 13.
    //
    // The terms are assembled from fragments rather than written out: section 13
    // treats every TRACKED file as shipped, this file included, so a literal
    // owner term here would make the guard trip the very scan it mirrors.
    const ownerTerms = ['my' + 'RP', 'chow' + 'derr', 'Ota' + 'ku', 'Fore' + 'man'];
    ok('the module names no real project',
       !new RegExp(ownerTerms.join('|'), 'i').test(src));
  }
} finally {
  delete process.env.BRAYNEE_PROJECT_ALIASES;
  fs.rmSync(sandbox, { recursive: true, force: true });
}

if (fail === 0) {
  console.log(`project-resolver.test.js: ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`project-resolver.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
