#!/usr/bin/env node
// gen-pr-standards.mjs — write braynee's reusable PR standards workflow, or a repo's
// caller for it. (cp-0wyf)
//
// Usage: node gen-pr-standards.mjs                 write .github/workflows/pr-standards.yml in braynee
//        node gen-pr-standards.mjs --check         exit 1 if the committed file is out of date
//        node gen-pr-standards.mjs --caller "<prefix> [<prefix> ...]" [--from owner/repo] [--ref pr-standards-v1]
//                                                  --from defaults to this plugin checkout's GitHub origin
//                                                  print a repo's caller workflow to stdout

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { reusablePrWorkflow, callerWorkflow } = require(path.join(import.meta.dirname, 'lib', 'ci-workflow-core.js'));

const args = process.argv.slice(2);
const opt = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def; };

if (args.includes('--caller')) {
  let from = opt('--from');
  if (!from) {
    const url = execFileSync('git', ['-C', path.join(import.meta.dirname, '..'), 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    from = url.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '');
  }
  process.stdout.write(callerWorkflow(opt('--caller'), from, opt('--ref', 'pr-standards-v1')));
  process.exit(0);
}

const file = path.join(import.meta.dirname, '..', '.github', 'workflows', 'pr-standards.yml');
const want = reusablePrWorkflow();
if (args.includes('--check')) {
  const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
  if (have !== want) { console.error('pr-standards.yml is out of date: run node scripts/gen-pr-standards.mjs'); process.exit(1); }
  console.log('pr-standards.yml is current.');
} else {
  fs.writeFileSync(file, want);
  console.log(`Wrote ${path.relative(process.cwd(), file)}`);
}
