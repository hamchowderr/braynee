#!/usr/bin/env node
// prd-paths.test.js — cp-s4uw.
//
// PRDs come in two shapes on disk and, before lib/prd-paths.js, the three tools
// disagreed about both. The two defects this locks, verified against the real
// vault before the fix:
//
//   * `prd-seed "<Name>"` died with EISDIR when `PRDs/<Name>` was a DIRECTORY:
//     fs.existsSync returns true for directories, so the resolver handed one to
//     readFileSync. Every folder PRD was unseedable.
//   * `prd-audit` walked recursively and audited each section file as its own
//     PRD, so chapters were reported as PRDs missing a project backlink and an
//     Acceptance Criteria section. Sections carry no frontmatter, so the
//     existing type!=prd filter never caught them.
//
// Runs entirely against a throwaway vault via $BRAYNEE_VAULT — never the user's.
// Pure Node, no deps, cross-platform. Exit 0 = pass, 1 = fail.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PRDP = require('./prd-paths.js');

let pass = 0, fail = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : '')); }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ROOT = path.join(__dirname, '..', '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 's4uw-'));

try {
  const VAULT = path.join(sandbox, 'vault');
  const PRD_DIR = path.join(VAULT, '2. Areas', 'Product Manager', 'PRDs');
  fs.mkdirSync(PRD_DIR, { recursive: true });
  fs.mkdirSync(path.join(VAULT, '1. Projects'), { recursive: true });
  fs.mkdirSync(path.join(VAULT, '3. Resources'), { recursive: true });

  const HUB_FM = (name) => [
    '---', 'type: prd', `name: ${name} PRD`, `project: "[[1. Projects/${name}]]"`,
    `folder: ${name.toLowerCase()}`, 'version: "1.0"', 'status: draft',
    'seeded: false', 'seeded_at: ""', 'seeded_count: 0', '---', '',
  ].join('\n');

  // ── fixtures: one monolithic PRD, one folder PRD ──────────────────────────
  fs.writeFileSync(path.join(PRD_DIR, 'Solo.md'),
    HUB_FM('Solo') + '# Solo\n\n## Acceptance Criteria\n\n- [ ] **[P0] A thing** — happens\n');

  const folderDir = path.join(PRD_DIR, 'Duo');
  fs.mkdirSync(folderDir, { recursive: true });
  fs.writeFileSync(path.join(folderDir, 'Duo.md'), HUB_FM('Duo') + '# Duo\n\n## MVP Definition\n\ncore\n');
  fs.writeFileSync(path.join(folderDir, 'Architecture.md'), '# Architecture\n\nstack details\n');
  // Criteria deliberately live in a SECTION, not the hub — the split case that
  // made prd-seed find zero issues and report a PRD as having nothing to build.
  fs.writeFileSync(path.join(folderDir, 'Acceptance.md'),
    '# Acceptance\n\n## Acceptance Criteria\n\n- [ ] **[P0] Split criterion** — found across files\n');

  // ── 1. resolution ─────────────────────────────────────────────────────────
  eq('a monolithic PRD resolves to its file',
     PRDP.resolvePrdHub('Solo', PRD_DIR), path.join(PRD_DIR, 'Solo.md'));
  eq('a folder PRD resolves to its HUB, not the directory (the EISDIR crash)',
     PRDP.resolvePrdHub('Duo', PRD_DIR), path.join(folderDir, 'Duo.md'));
  ok('the resolved hub is a FILE, not a directory',
     fs.statSync(PRDP.resolvePrdHub('Duo', PRD_DIR)).isFile());
  // Must return the ON-DISK spelling, not the caller's. Probing paths with
  // fs.existsSync passes this on Windows while returning "duo/duo.md" for a
  // folder named "Duo" — fine locally, wrong for wikilinks and on Linux.
  eq('resolution is case-insensitive AND returns the canonical casing',
     PRDP.resolvePrdHub('duo', PRD_DIR), path.join(folderDir, 'Duo.md'));

  fs.writeFileSync(path.join(PRD_DIR, 'Two-Words.md'), HUB_FM('Two Words') + '# Two Words\n');
  eq('a name with spaces resolves via its dashed filename',
     PRDP.resolvePrdHub('Two Words', PRD_DIR), path.join(PRD_DIR, 'Two-Words.md'));
  eq('an unknown name resolves to null, not a guess', PRDP.resolvePrdHub('Nope', PRD_DIR), null);
  eq('passing the directory path directly still yields the hub',
     PRDP.resolvePrdHub(folderDir, PRD_DIR), path.join(folderDir, 'Duo.md'));

  // ── 2. enumeration ────────────────────────────────────────────────────────
  // 3 PRDs (Solo, Two-Words, Duo) across 5 markdown files — Duo contributes its
  // hub only, never its two sections.
  const hubs = PRDP.listPrdHubs(PRD_DIR);
  eq('exactly one entry per PRD (3), not per markdown file (5)', hubs.length, 3);
  ok('the folder PRD contributes its hub', hubs.includes(path.join(folderDir, 'Duo.md')));
  ok('a section file is NOT listed as a PRD', !hubs.includes(path.join(folderDir, 'Architecture.md')));

  eq('sections are found for a folder PRD', PRDP.sectionFilesFor(path.join(folderDir, 'Duo.md'), PRD_DIR).length, 2);
  eq('a monolithic PRD has no sections', PRDP.sectionFilesFor(path.join(PRD_DIR, 'Solo.md'), PRD_DIR).length, 0);
  ok('the hub is not listed among its own sections',
     !PRDP.sectionFilesFor(path.join(folderDir, 'Duo.md'), PRD_DIR).includes(path.join(folderDir, 'Duo.md')));
  ok('isFolderPrd distinguishes the two shapes',
     PRDP.isFolderPrd(path.join(folderDir, 'Duo.md'), PRD_DIR) === true &&
     PRDP.isFolderPrd(path.join(PRD_DIR, 'Solo.md'), PRD_DIR) === false);

  // ── 3. full text spans sections ───────────────────────────────────────────
  const full = PRDP.prdFullText(path.join(folderDir, 'Duo.md'), PRD_DIR);
  ok('full text includes hub content', /core/.test(full));
  ok('full text includes section content', /stack details/.test(full));
  ok('full text includes criteria that live in a section', /Split criterion/.test(full));

  // ── 4. the tools agree — behavioral, against the real scripts ─────────────
  // prd-seed exits early unless the PRD's `folder:` repo exists and is beads-
  // initialized, so the fixture needs a real target repo or the criteria-parsing
  // assertion below would pass/fail for an unrelated reason.
  const CODE = path.join(sandbox, 'code');
  for (const repo of ['solo', 'duo', 'big']) {
    fs.mkdirSync(path.join(CODE, repo, '.beads'), { recursive: true });
    fs.writeFileSync(path.join(CODE, repo, '.beads', 'issues.jsonl'), '');
  }

  const run = (script, args) => spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, BRAYNEE_VAULT: VAULT, BRAYNEE_PROJECTS_DIR: CODE },
  });

  {
    const r = run('scripts/prd-seed.mjs', ['Duo', '--dry-run']);
    ok('prd-seed no longer crashes with EISDIR on a folder PRD',
       !/EISDIR/.test(r.stdout + r.stderr), (r.stdout + r.stderr).slice(0, 200));
    ok('prd-seed reads criteria that live in a section file',
       /Split criterion/.test(r.stdout + r.stderr) || /1 issue|1 to create/i.test(r.stdout),
       (r.stdout + r.stderr).slice(0, 300));
  }
  {
    const r = run('scripts/prd-audit.mjs', []);
    const out = r.stdout + r.stderr;
    ok('prd-audit counts 3 PRDs, not 5 files', /Found 3 PRD\(s\)/.test(out), out.slice(0, 300));
    ok('prd-audit does not report a section file as a PRD', !/### Duo.Architecture\.md/.test(out));
    ok('prd-audit reports the section count', /2 section file\(s\)/.test(out));
    // Isolate the Duo block — splitting on the heading alone would swallow every
    // later PRD's findings and make this assertion mean nothing.
    const duoBlock = (out.match(/### Duo[\\/]Duo\.md\n([\s\S]*?)(?=\n### |\n## |$)/) || [, ''])[1];
    ok('a folder PRD is not falsely flagged as missing Acceptance Criteria',
       !/Acceptance Criteria section not found/.test(duoBlock), duoBlock.slice(0, 200));
  }

  // ── 5. scaffolding the folder form ────────────────────────────────────────
  {
    const r = spawnSync(process.execPath,
      [path.join(ROOT, 'skills', 'prd', 'scripts', 'prd-new.mjs'), 'Trio', '--folder-form'], {
        encoding: 'utf8', timeout: 60000, windowsHide: true,
        env: { ...process.env, BRAYNEE_VAULT: VAULT },
      });
    const trioDir = path.join(PRD_DIR, 'Trio');
    ok('prd-new --folder-form creates the folder', fs.existsSync(trioDir), r.stderr.slice(0, 200));
    ok('...with a hub named after it', fs.existsSync(path.join(trioDir, 'Trio.md')));
    ok('...and section files', fs.existsSync(path.join(trioDir, 'Architecture.md')));
    const hub = fs.readFileSync(path.join(trioDir, 'Trio.md'), 'utf8');
    ok('the hub keeps Acceptance Criteria (prd-seed parses it)', /## Acceptance Criteria/.test(hub));
    ok('the hub keeps MVP Definition (the seed gate reads it)', /## MVP Definition/.test(hub));
    ok('a split-out section is linked from the hub, not deleted', /\[\[.*Architecture\|Architecture\]\]/.test(hub));
    ok('the scaffolded folder PRD resolves through the shared resolver',
       PRDP.resolvePrdHub('Trio', PRD_DIR) === path.join(trioDir, 'Trio.md'));
    ok('exactly ONE file in the folder is a PRD hub',
       fs.readdirSync(trioDir).filter((f) => PRDP.isPrdHub(path.join(trioDir, f))).length === 1);

    const r2 = spawnSync(process.execPath,
      [path.join(ROOT, 'skills', 'prd', 'scripts', 'prd-new.mjs'), 'Trio', '--folder-form'], {
        encoding: 'utf8', timeout: 60000, windowsHide: true,
        env: { ...process.env, BRAYNEE_VAULT: VAULT },
      });
    ok('re-scaffolding an existing PRD refuses instead of clobbering', r2.status !== 0);
  }

  // ── 6. splitting an existing monolithic PRD ───────────────────────────────
  {
    const big = HUB_FM('Big') + [
      '# Big', '', '## MVP Definition', '', 'the mvp', '',
      '## Architecture', '', 'arch line one', 'arch line two', '',
      '## Scope', '', 'in scope things', '',
      '## Acceptance Criteria', '', '- [ ] **[P0] Keep me** — in the hub', '',
    ].join('\n');
    fs.writeFileSync(path.join(PRD_DIR, 'Big.md'), big);

    const dry = run('scripts/prd-split.mjs', ['Big', '--dry-run']);
    ok('split --dry-run writes nothing', !fs.existsSync(path.join(PRD_DIR, 'Big')), dry.stdout.slice(0, 200));
    ok('split --dry-run reports the content check', /all \d+ non-blank lines accounted for/.test(dry.stdout),
       dry.stdout.slice(0, 300));

    const r = run('scripts/prd-split.mjs', ['Big']);
    const bigDir = path.join(PRD_DIR, 'Big');
    ok('split created the folder', fs.existsSync(bigDir), (r.stdout + r.stderr).slice(0, 300));
    ok('...with the hub', fs.existsSync(path.join(bigDir, 'Big.md')));
    ok('...and the moved sections', fs.existsSync(path.join(bigDir, 'Architecture.md')) &&
                                    fs.existsSync(path.join(bigDir, 'Scope.md')));
    ok('the original monolithic file is gone', !fs.existsSync(path.join(PRD_DIR, 'Big.md')));

    const hub = fs.readFileSync(path.join(bigDir, 'Big.md'), 'utf8');
    ok('the hub keeps its frontmatter', /^---\ntype: prd/.test(hub));
    ok('Acceptance Criteria stayed in the hub', /- \[ \] \*\*\[P0\] Keep me\*\*/.test(hub));
    ok('MVP Definition stayed in the hub', /the mvp/.test(hub));
    ok('a moved section leaves a link behind', /Moved to \[\[.*Architecture\|Architecture\]\]/.test(hub));

    const arch = fs.readFileSync(path.join(bigDir, 'Architecture.md'), 'utf8');
    ok('moved content is intact', /arch line one/.test(arch) && /arch line two/.test(arch));
    ok('moved content is NOT also left in the hub', !/arch line one/.test(hub));

    // The failure that matters: content silently lost in the move.
    const all = hub + fs.readFileSync(path.join(bigDir, 'Architecture.md'), 'utf8')
                    + fs.readFileSync(path.join(bigDir, 'Scope.md'), 'utf8');
    const lost = big.replace(/^---[\s\S]*?---\n/, '').split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .filter((l) => !all.includes(l));
    ok(`no content lost in the split (${lost.length} missing)`, lost.length === 0, lost.slice(0, 4).join(' | '));

    ok('splitting an already-split PRD refuses', run('scripts/prd-split.mjs', ['Big']).status !== 0);
    ok('the split PRD resolves and audits as ONE PRD',
       PRDP.resolvePrdHub('Big', PRD_DIR) === path.join(bigDir, 'Big.md'));
  }
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

if (fail === 0) {
  console.log(`prd-paths.test.js: ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`prd-paths.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
