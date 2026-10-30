// Data modulation sources (doc/bindings.md, Effects and modulation, step 4).
// Re-evaluates the source's expression on events that can affect it and on orbit posts, and
// calls `engine.postModValue(id, value, smoothMs)` at most 30 times per second while the value
// changes. A value that arrives within the post interval waits for the next tick; a newer value
// replaces it.

import { evaluate } from '../expr/evaluate.js';
import { collectDeps } from '../expr/deps.js';
import { postedValue } from './mod-config.js';
import { LIMITS } from './limits.js';

/**
 * @param {import('./mod-config.js').DataSourceSpec} spec
 * @param {import('./runtime.js').BindingEnv} env
 */
export function createDataSource(spec, env) {
  const ctx = env.ctxFor(spec.id);
  const component = `mod.${spec.id}`;
  const deps = collectDeps(spec.expr);
  /** @type {number | null} */
  let lastPosted = null;
  let lastPostMs = -Infinity;
  /** @type {{ raw: number, posted: number, traceId: string | null } | null} */
  let pending = null;
  let latestRaw = /** @type {number | null} */ (null);

  function post(p, nowMs) {
    env.engine.postModValue(spec.id, p.posted, spec.smoothMs);
    lastPosted = p.posted;
    lastPostMs = nowMs;
    pending = null;
    const data = { event: 'modValue', source: spec.id, class: spec.class, raw: p.raw, posted: p.posted };
    if (spec.timeScale > 1) data.timeScale = spec.timeScale;
    env.emit('AUDIO', component, 'modValue', data, { traceId: p.traceId });
  }

  function evaluateNow(traceId) {
    const raw = evaluate(spec.expr, null, ctx);
    if (typeof raw !== 'number') return; // null keeps the last value
    latestRaw = raw;
    const posted = postedValue(spec, raw);
    if (posted === lastPosted) { pending = null; return; }
    const p = { raw, posted, traceId };
    const now = env.now();
    if (now - lastPostMs >= LIMITS.postIntervalMs) post(p, now);
    else pending = p;
  }

  return {
    id: spec.id,
    kind: 'data',
    spec,
    groups: deps.groups,
    usesOrbit: deps.orbit,
    init() { evaluateNow(null); },
    onEvent(e) { evaluateNow(e.traceId); },
    onOrbit() { evaluateNow(null); },
    tick(nowMs) {
      if (pending && nowMs - lastPostMs >= LIMITS.postIntervalMs) post(pending, nowMs);
    },
    release() {},
    voiceTag() { return null; },
    snapshot() { return []; },
    /** Latest raw and posted values, for the console's Modulation panel. */
    state() { return { id: spec.id, class: spec.class, raw: latestRaw, posted: lastPosted, timeScale: spec.timeScale, owner: spec.owner, kind: spec.kind }; },
  };
}
