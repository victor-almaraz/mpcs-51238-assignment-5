// Type checking of piece scripts against builder.d.ts with the TypeScript compiler and
// @typescript/vfs (doc/piece-dsl.md, Type checking). The compiler, the vfs module and the library
// files are injected: the editor worker passes bundled copies, Node scripts and tests pass the
// installed packages. Each diagnostic becomes a `type_error` warning.

import { problem } from './problem-codes.js';

/** @typedef {import('./problem-codes.js').Problem} Problem */
/** @typedef {{ code: number, line: number, column: number, start: number, length: number, message: string }} Diagnostic */

export const PIECE_PATH = '/piece.ts';
export const BUILDER_PATH = '/builder.d.ts';
/** Root library file; `libClosure` adds the files it references. */
export const ROOT_LIB = 'lib.es2022.d.ts';

/** @param {any} ts */
export function compilerOptions(ts) {
  return {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: [ROOT_LIB],
    noEmit: true,
    types: [],
  };
}

/**
 * The library files needed for ROOT_LIB, keyed by vfs path ('/lib.es2022.d.ts').
 * @param {(fileName: string) => string} readLib returns the text of a lib file such as 'lib.es5.d.ts'
 * @returns {Record<string, string>}
 */
export function libClosure(readLib) {
  /** @type {Record<string, string>} */
  const out = {};
  const queue = [ROOT_LIB];
  while (queue.length) {
    const name = /** @type {string} */ (queue.shift());
    if (`/${name}` in out) continue;
    const text = readLib(name);
    out[`/${name}`] = text;
    for (const m of text.matchAll(/^\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/gm)) queue.push(`lib.${m[1].toLowerCase()}.d.ts`);
  }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/**
 * @param {{ ts: any, vfs: any, libFiles: Record<string, string>, builderDts: string }} deps
 */
export function createChecker({ ts, vfs, libFiles, builderDts }) {
  const map = new Map(Object.entries(libFiles));
  map.set(BUILDER_PATH, builderDts);
  map.set(PIECE_PATH, ' ');
  const system = vfs.createSystem(map);
  const env = vfs.createVirtualTypeScriptEnvironment(system, [BUILDER_PATH, PIECE_PATH], ts, compilerOptions(ts));

  /** @param {string} source @returns {Diagnostic[]} */
  function diagnostics(source) {
    env.updateFile(PIECE_PATH, source.length ? source : ' ');
    const ls = env.languageService;
    const file = env.getSourceFile(PIECE_PATH);
    const diags = [...ls.getSyntacticDiagnostics(PIECE_PATH), ...ls.getSemanticDiagnostics(PIECE_PATH)];
    return diags.map((d) => {
      const start = d.start ?? 0;
      const lc = file ? ts.getLineAndCharacterOfPosition(file, start) : { line: 0, character: 0 };
      return {
        code: d.code,
        line: lc.line + 1,
        column: lc.character + 1,
        start,
        length: d.length ?? 0,
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      };
    });
  }

  /** @param {string} source @returns {Problem[]} */
  function check(source) {
    return diagnostics(source).map((d) => problem('type_error', '', `TS${d.code}: ${d.message}`, d.line));
  }

  return { env, diagnostics, check };
}
