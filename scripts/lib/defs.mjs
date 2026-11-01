// Loads the definition tables for build scripts. By default the tables come from the app's
// modules: src/dsl/engine-defs.js (the user's engine), src/visual/layer-defs.js and
// src/sky/groups.json. Each `--defs <module>` argument supplies replacements: a module exporting
// any of PARAM_DEFS, TUNING_DEFS, EFFECT_REGISTRY, LAYER_DEFS and GROUPS.
// Example: --defs tests/fixtures/dsl/engine-defs.js builds against the fixture engine tables.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeDefs } from '../../src/dsl/defs.js';

/** @param {string} root @param {string[]} defsFiles module paths from `--defs`, relative to `root` */
export async function loadDefs(root, defsFiles) {
  /** @type {Record<string, any>} */
  const tables = {};
  for (const file of defsFiles) {
    const mod = await import(pathToFileURL(resolve(root, file)).href);
    for (const k of ['PARAM_DEFS', 'TUNING_DEFS', 'EFFECT_REGISTRY', 'LAYER_DEFS', 'GROUPS']) {
      if (mod[k] !== undefined) tables[k] = mod[k];
    }
  }
  if (!tables.PARAM_DEFS || !tables.EFFECT_REGISTRY) {
    let engine;
    try {
      engine = await import(pathToFileURL(resolve(root, 'src/dsl/engine-defs.js')).href);
    } catch (e) {
      throw new Error(`The engine definition tables could not be loaded (${/** @type {Error} */ (e).message}). `
        + 'The user\'s engine in src/audio/ provides them; until it is present, pass --defs tests/fixtures/dsl/engine-defs.js');
    }
    tables.PARAM_DEFS ??= engine.PARAM_DEFS;
    tables.TUNING_DEFS ??= engine.TUNING_DEFS;
    tables.EFFECT_REGISTRY ??= engine.EFFECT_REGISTRY;
  }
  tables.LAYER_DEFS ??= (await import(pathToFileURL(resolve(root, 'src/visual/layer-defs.js')).href)).LAYER_DEFS;
  tables.GROUPS ??= JSON.parse(readFileSync(resolve(root, 'src/sky/groups.json'), 'utf8'));
  return normalizeDefs({
    paramDefs: tables.PARAM_DEFS,
    tuningDefs: tables.TUNING_DEFS,
    effectRegistry: tables.EFFECT_REGISTRY,
    layerDefs: tables.LAYER_DEFS,
    groups: tables.GROUPS,
  });
}
