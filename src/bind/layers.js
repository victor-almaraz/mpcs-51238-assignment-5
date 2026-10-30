// Layer property values for the renderer (doc/visuals.md, Layer properties).
// Each property is a constant or an expression evaluated for one object. A property whose
// expression yields `null` or throws is `null`, and the renderer uses its default from
// `src/visual/layer-defs.js`. Clamping to the property range is the renderer's.

import { evaluate } from '../expr/evaluate.js';

/**
 * @param {{ id: string, props?: Record<string, unknown> }} layer
 * @param {any} obj current object, or null for full-screen layers
 * @param {import('../expr/evaluate.js').EvalContext} ctx
 * @param {(prop: string, err: Error) => void} [onError] called once per failing property
 * @returns {Record<string, unknown>}
 */
export function evaluateLayerProps(layer, obj, ctx, onError) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [name, value] of Object.entries(layer.props ?? {})) {
    try {
      out[name] = evaluate(/** @type {any} */ (value), obj, ctx);
    } catch (err) {
      out[name] = null;
      if (onError) onError(name, err instanceof Error ? err : new Error(String(err)));
    }
  }
  return out;
}
