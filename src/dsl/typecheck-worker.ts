// Editor-only type-check worker (doc/piece-dsl.md, Type checking). Loaded with
//   new Worker(new URL('../dsl/typecheck-worker.ts', import.meta.url), { type: 'module' })
// the first time the editor opens; /listen, /try run mode and /projects/[id]/run never load it.
// The library files and builder.d.ts are bundled (ts-lib-files.js, builder-dts.js); the worker
// fetches nothing at runtime.
//
// Protocol (typecheck-client.js wraps it):
//   page → worker  { id, method, args }        worker → page  { id, result } | { id, error }
//   methods: the @valtown/codemirror-ts worker methods (initialize, updateFile, getLints,
//   getAutocompletion, getHover) and check(source) → Problem[] (type_error warnings).
//   After updateFile for /piece.ts the worker re-checks 300 ms after the last edit and posts
//   { event: 'problems', problems }.

import ts from 'typescript';
import * as vfs from '@typescript/vfs';
import { createWorker } from '@valtown/codemirror-ts/worker';
import builderDts from './builder-dts.js';
import libFiles from './ts-lib-files.js';
import { PIECE_PATH, createChecker } from './typecheck.js';

const RECHECK_MS = 300;

const checker = createChecker({ ts, vfs, libFiles, builderDts });
const editor = createWorker(() => checker.env);
let latest = '';
let timer: ReturnType<typeof setTimeout> | undefined;

const methods: Record<string, (arg: any) => unknown> = {
  initialize: () => editor.initialize(),
  updateFile: (arg: { path: string; code: string }) => {
    editor.updateFile(arg);
    if (arg.path === PIECE_PATH) {
      latest = arg.code;
      clearTimeout(timer);
      timer = setTimeout(() => {
        postMessage({ event: 'problems', problems: checker.check(latest) });
      }, RECHECK_MS);
    }
  },
  getLints: (arg) => editor.getLints(arg),
  getAutocompletion: (arg) => editor.getAutocompletion(arg),
  getHover: (arg) => editor.getHover(arg),
  check: (source: string) => checker.check(source),
};

self.onmessage = async (e: MessageEvent) => {
  const { id, method, args } = (e.data ?? {}) as { id: number; method: string; args: unknown[] };
  const fn = Object.prototype.hasOwnProperty.call(methods, method) ? methods[method] : undefined;
  if (!fn) {
    postMessage({ id, error: `unknown method ${String(method)}` });
    return;
  }
  try {
    postMessage({ id, result: await fn((args ?? [])[0]) });
  } catch (err) {
    postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
