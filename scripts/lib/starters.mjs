// Builds the starter projects (doc/ui.md, Starter projects): each content/starters/<slug>.ts from
// the manifest is built with the builder and validator and type-checked against builder.d.ts.
// Any error, warning or type diagnostic fails the starter.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import * as vfs from '@typescript/vfs';
import { transform } from 'sucrase';
import { buildPiece } from '../../src/dsl/run-script.js';
import { generateBuilderDts } from '../../src/dsl/gen-dts.js';
import { createChecker, libClosure } from '../../src/dsl/typecheck.js';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** @param {string} source */
const removeTypes = (source) => transform(source, { transforms: ['typescript'] }).code;

/** Node copies of the ES2022 library declarations. */
export function nodeLibFiles() {
  const dir = dirname(createRequire(import.meta.url).resolve('typescript/lib/typescript.js'));
  return libClosure((name) => readFileSync(join(dir, name), 'utf8'));
}

/**
 * @param {string} root repository root
 * @param {import('../../src/dsl/defs.js').Defs} defs
 * @returns {{ version: number, starters: { slug: string, name: string, source: string, ir: any, text: string, problems: string[] }[], errors: string[] }}
 */
export function buildStarters(root, defs) {
  const dir = join(root, 'content/starters');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (!Number.isInteger(manifest?.version) || manifest.version < 1) throw new Error('content/starters/manifest.json: version must be a positive integer');
  if (!Array.isArray(manifest.starters)) throw new Error('content/starters/manifest.json: starters must be a list');
  const checker = createChecker({ ts, vfs, libFiles: nodeLibFiles(), builderDts: generateBuilderDts(defs) });
  /** @type {string[]} */
  const errors = [];
  const seen = new Set();
  const starters = manifest.starters.map((/** @type {any} */ entry, /** @type {number} */ i) => {
    const slug = entry?.slug;
    const name = entry?.name;
    if (typeof slug !== 'string' || !SLUG.test(slug)) throw new Error(`content/starters/manifest.json: starters[${i}].slug must be a lowercase slug`);
    if (typeof name !== 'string' || !name.trim()) throw new Error(`content/starters/manifest.json: starters[${i}].name must be text`);
    if (seen.has(slug)) throw new Error(`content/starters/manifest.json: duplicate slug ${slug}`);
    seen.add(slug);
    const file = join(dir, `${slug}.ts`);
    if (!existsSync(file)) throw new Error(`content/starters/${slug}.ts is missing`);
    const source = readFileSync(file, 'utf8');
    const built = buildPiece(source, defs, { transform: removeTypes });
    const problems = [
      ...built.problems.map((p) => `${slug}.ts:${p.line ?? '?'} ${p.severity} ${p.code} ${p.path} ${p.message}`),
      ...checker.check(source).map((p) => `${slug}.ts:${p.line ?? '?'} type ${p.message}`),
    ];
    errors.push(...problems);
    const text = built.ir ? `${JSON.stringify(built.ir, null, 2)}\n` : '';
    return { slug, name, source, ir: built.ir, text, problems };
  });
  return { version: manifest.version, starters, errors };
}
