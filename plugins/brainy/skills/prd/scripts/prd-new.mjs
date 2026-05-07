#!/usr/bin/env node
// prd-new.mjs — Scaffold a new PRD with the canonical brainy schema.
// Usage: node prd-new.mjs "<Name>" [--folder <slug>] [--client <name>]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
if (!args[0] || args[0].startsWith('--')) {
  console.error('Usage: prd-new.mjs "<Name>" [--folder <slug>] [--client <name>]');
  process.exit(1);
}
const name = args[0];
const folderArg = args.indexOf('--folder');
const folder = folderArg !== -1 ? args[folderArg + 1] : name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const clientArg = args.indexOf('--client');
const client = clientArg !== -1 ? args[clientArg + 1] : null;

const VAULT = path.join(os.homedir(), 'Obsidian Vault');
const PRD_DIR = path.join(VAULT, '2. Areas', 'Product Manager', 'PRDs');
const today = new Date().toISOString().slice(0, 10);
const slug = name.replace(/[^A-Za-z0-9-]/g, '-');
const prdPath = path.join(PRD_DIR, `${slug}.md`);

if (fs.existsSync(prdPath)) {
  console.error(`PRD already exists: ${prdPath}`);
  process.exit(1);
}

const fm = [
  '---',
  'type: prd',
  `name: ${name} PRD`,
  `project: "[[1. Projects/${name}]]"`,
  `folder: ${folder}`,
  'version: "1.0"',
  `created: ${today}`,
  `updated: ${today}`,
  'status: draft',
  'build_status: drafting',
  ...(client ? [`client: ${client}`] : []),
  'seeded: false',
  'seeded_at: ""',
  'seeded_count: 0',
  'tags:',
  '  - prd',
  '---',
].join('\n');

const body = `
# ${name} — Product Requirements Document
**One-sentence tagline goes here.**

One-paragraph elevator pitch. What is being built, for whom, and why now.

**Product Manager:** Chowderr | Otaku Solutions | v1.0 | ${today}

**Project:** [[1. Projects/${name}]]

---

## Triple-Purpose Asset

- **Client / Revenue:** …
- **Consulting Template:** …
- **PM Portfolio Piece:** …

---

## North Star Metric

⭐ **<metric>** — why this metric captures the value chain.

### Activation Moment

The first time a user experiences the core value.

### Launch OKRs (First 30 Days)

| Objective | Key Result | Target |
|---|---|---|
| | | |

---

## Lean Canvas

| Block | Detail |
|---|---|
| Problem | |
| Customer Segments | |
| Unique Value Proposition | |
| Solution | |
| Channels | |
| Revenue Streams | |
| Cost Structure | |
| Key Metrics | |
| Unfair Advantage | |

---

## Personas / Jobs-To-Be-Done

### Primary persona

### Secondary persona

---

## User Journeys

### Happy path

### Edge cases

---

## Scope

### In scope

### Out of scope (V1)

### Future (V2+)

---

## Architecture

- **Stack:** …
- **Key components:** …
- **Integrations:** …

---

## Milestones

- **MVP** — …
- **v1.1** — …
- **v2** — …

---

## Acceptance Criteria

### Milestone: MVP

- [ ] **[P0] First criterion** — what must be true / observable for this to count as done
- [ ] **[P1] Second criterion** — …
- [ ] **[P2] Third criterion** — …

### Milestone: v1.1

- [ ] **[P1] First criterion** — …

---

## Risks & Open Questions

- **Risk:** …
- **Open question:** …

---

## Appendix / Links

- [[1. Projects/${name}]]
`;

fs.mkdirSync(PRD_DIR, { recursive: true });
fs.writeFileSync(prdPath, fm + '\n' + body, 'utf-8');
console.log(`Created: ${prdPath}`);
console.log(`Folder join key: ${folder} → ~/code/${folder}/`);
console.log(`Next: fill in sections, then run prd-seed.mjs "${slug}" to create bd issues.`);
