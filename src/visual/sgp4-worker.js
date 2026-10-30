/**
 * SGP4 Web Worker (doc/visuals.md, Orbit propagation). Receives element sets
 * as flat SkyObject fields and propagates them at 2 Hz. All logic lives in
 * propagation-core.js.
 */
import { createPropagationCore, TICK_MS } from './propagation-core.js';

const core = createPropagationCore({
  post: (msg, transfer) => /** @type {any} */ (self).postMessage(msg, transfer ?? []),
});

/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg?.type === 'start') {
    if (timer === null) { core.tick(); timer = setInterval(core.tick, TICK_MS); }
    return;
  }
  if (msg?.type === 'stop') {
    if (timer !== null) clearInterval(timer);
    timer = null;
    return;
  }
  core.handle(msg);
};
