// Test helpers: fixture definition tables and a Node build of a script.

import { readFileSync } from 'node:fs';
import { transform } from 'sucrase';
import { normalizeDefs } from '../../../src/dsl/defs.js';
import { buildPiece } from '../../../src/dsl/run-script.js';
import { EFFECT_REGISTRY, PARAM_DEFS, TUNING_DEFS } from './engine-defs.js';
import { LAYER_DEFS } from '../../../src/visual/layer-defs.js';

const groups = JSON.parse(readFileSync(new URL('../../../src/sky/groups.json', import.meta.url), 'utf8'));

/** Normalized defs: fixture engine tables, the real src/visual/layer-defs.js and src/sky/groups.json. */
export const defs = normalizeDefs({
  paramDefs: PARAM_DEFS, tuningDefs: TUNING_DEFS, effectRegistry: EFFECT_REGISTRY, layerDefs: LAYER_DEFS, groups,
});

/** @param {string} source */
export const sucrase = (source) => transform(source, { transforms: ['typescript'] }).code;

/** @param {string} source @param {object} [opts] */
export function build(source, opts = {}) {
  return buildPiece(source, defs, { transform: sucrase, ...opts });
}

/** Problems without line numbers, for compact assertions. @param {{ problems: any[] }} r */
export function codes(r) {
  return r.problems.map((p) => `${p.code} ${p.path}`);
}

/** The `ts` code blocks of a Markdown file whose info string is exactly `info`. */
export function codeBlocks(/** @type {string} */ markdown, /** @type {string} */ info) {
  const out = [];
  const re = /^```([^\n]*)\n([\s\S]*?)^```$/gm;
  for (const m of markdown.matchAll(re)) if (m[1].trim() === info) out.push(m[2]);
  return out;
}
