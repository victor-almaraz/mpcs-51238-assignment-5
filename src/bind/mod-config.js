// Converts the IR's `lfos` and `mods` to the engine configuration (doc/bindings.md, Effects and
// modulation; doc/audio/modulation.md, Engine API).

import { collectDeps, sourceClass } from '../expr/deps.js';
import { LIMITS } from './limits.js';

/**
 * @typedef {{ id: string, shape: string, rate: number | { sync: string } | { data: string, min: number, max: number },
 *   phase: number, retrigger: boolean, smooth: number }} LfoSpec
 * @typedef {{ target: string, source: string, depth: number }} RouteSpec
 * @typedef {object} DataSourceSpec
 * @property {string} id            `dat<n>`
 * @property {'rate' | 'route'} kind
 * @property {object} expr          expression node
 * @property {number} min           rate range (rate) or −1 (route)
 * @property {number} max           rate range (rate) or 1 (route)
 * @property {number} smoothMs
 * @property {'vlfo' | 'random-walk' | 'step'} class
 * @property {number} timeScale     largest orbit timeScale, 1 without orbit nodes
 * @property {string} owner         LFO id (rate) or route target (route)
 */

/**
 * Data source ids are assigned in IR order: first LFO rate expressions, then route expressions.
 * @param {{ lfos?: any[], mods?: any[] }} ir
 * @returns {{ lfos: LfoSpec[], routes: RouteSpec[], dataSources: DataSourceSpec[] }}
 */
export function buildModConfig(ir) {
  const dataSources = [];
  const add = (kind, expr, min, max, smoothMs, owner) => {
    const deps = collectDeps(expr);
    const spec = {
      id: `dat${dataSources.length}`, kind, expr, min, max,
      smoothMs: smoothMs ?? (deps.orbit ? LIMITS.defaultOrbitSmoothMs : LIMITS.defaultSmoothMs),
      class: sourceClass(deps), timeScale: deps.timeScale, owner,
    };
    dataSources.push(spec);
    return spec.id;
  };

  const lfos = (ir.lfos ?? []).map((l) => {
    let rate = l.rate;
    if (rate && typeof rate === 'object' && 'expr' in rate) {
      if (!(rate.max > rate.min)) throw new Error(`LFO ${l.id}: rate range min ${rate.min} must be below max ${rate.max}`);
      const id = add('rate', rate.expr, rate.min, rate.max, rate.smoothMs, l.id);
      rate = { data: id, min: rate.min, max: rate.max };
    }
    return { id: l.id, shape: l.shape, rate, phase: l.phase, retrigger: l.retrigger, smooth: l.smooth };
  });

  const routes = (ir.mods ?? []).map((m) => {
    let source;
    if (m.source && typeof m.source.lfo === 'string') source = m.source.lfo;
    else if (m.source && 'expr' in m.source) source = add('route', m.source.expr, -1, 1, m.smoothMs, m.target);
    else throw new Error(`Route to ${m.target}: source must be { lfo } or { expr }`);
    return { target: m.target, source, depth: m.depth };
  });

  return { lfos, routes, dataSources };
}

/**
 * Value posted for a data source, from the expression result (before clamping).
 * Route sources clamp to −1..1. Rate sources clamp to [min, max] Hz and post
 * `2 · (hz − min) / (max − min) − 1`.
 * @param {DataSourceSpec} spec
 * @param {number} raw
 * @returns {number}
 */
export function postedValue(spec, raw) {
  if (spec.kind === 'rate') {
    const hz = Math.min(Math.max(raw, spec.min), spec.max);
    return (2 * (hz - spec.min)) / (spec.max - spec.min) - 1;
  }
  return Math.min(Math.max(raw, -1), 1);
}
