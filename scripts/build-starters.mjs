#!/usr/bin/env node
// Builds content/starters/<slug>.ts to content/starters/<slug>.ir.json (doc/ui.md, Starter
// projects). Fails on any error, warning or type diagnostic. Successful runs print nothing;
// diagnostics go to stderr as JSON lines.
//
// Usage: node scripts/build-starters.mjs [--defs <module>]... [--check]
//   --defs   replaces definition tables (scripts/lib/defs.mjs), for example
//            --defs tests/fixtures/dsl/engine-defs.js until the user's engine is present
//   --check  fails when an .ir.json differs from the build, instead of writing it

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDefs } from './lib/defs.mjs';
import { diag, parseArgs, writeOrCheck } from './lib/cli.mjs';
import { buildStarters } from './lib/starters.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2), { check: 'boolean', defs: 'list' }, 'node scripts/build-starters.mjs [--defs <module>]... [--check]', 'build_starters');
const { check } = args;

try {
  const defs = await loadDefs(ROOT, args.defs);
  const { starters, errors } = buildStarters(ROOT, defs);
  for (const e of errors) diag({ level: 'error', event: 'build_starters', message: e });
  if (errors.length) {
    process.exitCode = 1;
  } else {
    for (const s of starters) {
      const file = join(ROOT, 'content/starters', `${s.slug}.ir.json`);
      if (!writeOrCheck(file, s.text, check)) {
        diag({ level: 'error', event: 'build_starters', file: `content/starters/${s.slug}.ir.json`, message: 'out of date; run node scripts/build-starters.mjs' });
        process.exitCode = 1;
      }
    }
  }
} catch (e) {
  diag({ level: 'error', event: 'build_starters', message: /** @type {Error} */ (e).message });
  process.exitCode = 1;
}
