// A small CommonJS linker for the generated worker scripts (build-worklets, build-sandbox): each
// module becomes a function in one file without import or export statements, so it loads as a
// classic script, a module worker or an AudioWorklet module.

import { readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { transform } from 'sucrase';

/** An ES module as CommonJS. @param {string} file */
export function esToCommonJs(file) {
  return transform(readFileSync(file, 'utf8'), { transforms: ['imports'], filePath: file }).code;
}

/**
 * Bundles `entry` and everything it requires.
 * @param {{
 *   root: string, entry: string, header: string,
 *   load: (file: string) => string,
 *   resolve: (spec: string, fromDir: string) => string | null | -1,
 * }} opts  `resolve` returns a file, -1 for a stubbed module (an empty object) or null for one that
 *          is never required at run time (requiring it throws)
 * @returns {string}
 */
export function bundle({ root, entry, header, load, resolve }) {
  /** @type {Map<string, { code: string, deps: Record<string, number | null> }>} */
  const mods = new Map();
  /** @type {string[]} */
  const queue = [];
  /** @type {Map<string, number>} */
  const ids = new Map();
  const idOf = (/** @type {string} */ file) => {
    if (!ids.has(file)) { ids.set(file, ids.size); mods.set(file, { code: '', deps: {} }); queue.push(file); }
    return /** @type {number} */ (ids.get(file));
  };
  idOf(entry);
  while (queue.length) {
    const file = /** @type {string} */ (queue.shift());
    const mod = /** @type {{ code: string, deps: Record<string, number | null> }} */ (mods.get(file));
    mod.code = load(file);
    for (const m of mod.code.matchAll(/\brequire\((['"])([^'"\n]+)\1\)/g)) {
      const spec = m[2];
      if (spec in mod.deps) continue;
      const target = resolve(spec, dirname(file));
      mod.deps[spec] = target === -1 ? -1 : target ? idOf(target) : null;
    }
  }
  const entries = [...mods.entries()].map(([file, m]) => {
    const name = relative(root, file).split('\\').join('/');
    return `/* ${name} */ [function (module, exports, require) {\n${m.code}\n}, ${JSON.stringify(m.deps)}]`;
  });
  return `${header}
(function () {
  'use strict';
  var defs = [
${entries.join(',\n')}
  ];
  var cache = [];
  function load(id) {
    if (cache[id]) return cache[id].exports;
    var module = { exports: {} };
    cache[id] = module;
    var deps = defs[id][1];
    defs[id][0].call(module.exports, module, module.exports, function (spec) {
      var dep = deps[spec];
      if (dep === -1) return {};
      if (dep === null || dep === undefined) throw new Error('bundle: module ' + spec + ' is not bundled');
      return load(dep);
    });
    return module.exports;
  }
  load(0);
})();
`;
}
