// Runs public/dsl-sandbox.js in a Node worker thread behind the Web Worker interface the page uses
// (`postMessage`, `onmessage`, `terminate`). The thread defines `self`, `postMessage` and stand-ins
// for the browser network globals, so tests can check that the sandbox removes them.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const SANDBOX = fileURLToPath(new URL('../../../public/dsl-sandbox.js', import.meta.url));

const BOOT = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const vm = require('node:vm');
globalThis.self = globalThis;
globalThis.postMessage = (m) => parentPort.postMessage(m);
for (const k of ['XMLHttpRequest', 'EventSource', 'importScripts', 'indexedDB']) globalThis[k] = function () {};
parentPort.on('message', (m) => {
  if (m && m.__probe) {
    parentPort.postMessage({ __probe: m.__probe.map((k) => typeof globalThis[k]) });
    return;
  }
  globalThis.onmessage({ data: m });
});
vm.runInThisContext(fs.readFileSync(workerData.file, 'utf8'), { filename: workerData.file });
`;

/** @returns {import('../../../src/dsl/run-sandbox.js').WorkerLike & { probe(names: string[]): Promise<string[]> }} */
export function nodeSandboxWorker() {
  const w = new Worker(BOOT, { eval: true, workerData: { file: SANDBOX } });
  /** @type {((e: { data: any }) => void) | null} */
  let handler = null;
  /** @type {((v: string[]) => void) | null} */
  let probeWaiter = null;
  w.on('message', (data) => {
    if (data && data.__probe) { probeWaiter?.(data.__probe); return; }
    handler?.({ data });
  });
  return {
    postMessage: (m) => w.postMessage(m),
    terminate: () => { w.terminate(); },
    get onmessage() { return handler; },
    set onmessage(fn) { handler = fn; },
    onerror: null,
    probe(names) {
      return new Promise((resolve) => { probeWaiter = resolve; w.postMessage({ __probe: names }); });
    },
  };
}
