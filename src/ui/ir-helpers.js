// IR-derived inputs for the propagator and the renderer (doc/visuals.md, Interface and Propagator
// interface). Pure functions over a validated IR.

import { forEachExprPosition, forEachNode, isNode, objectGroup } from '../dsl/ir-walk.js';

const AUDIO_OPS = new Set(['level', 'spectrum', 'env']);

/**
 * Orbit sources for `propagator.setOrbitSources`: one entry per distinct (object, quantity,
 * timeScale); `objectId` null computes the quantity for every object of `group`.
 * @param {any} ir
 * @returns {{ objectId: string | null, group: string, quantity: string, timeScale: number }[]}
 */
export function orbitSourcesOf(ir) {
  const out = new Map();
  forEachExprPosition(ir, (value, path, ctx) => forEachNode(value, path, (node) => {
    if (node.op !== 'orbit') return;
    const [quantity, objectId, ts] = node.args;
    const id = typeof objectId === 'string' ? objectId : null;
    const group = id ? objectGroup(id) : ctx.object;
    if (typeof quantity !== 'string' || !group) return;
    const timeScale = typeof ts === 'number' && Number.isFinite(ts) ? ts : 1;
    const key = `${id ?? `${group}:*`}|${quantity}|${timeScale}`;
    if (!out.has(key)) out.set(key, { objectId: id, group, quantity, timeScale });
  }));
  return [...out.values()];
}

/** The IR's `celestrak.*` groups, for `propagator.setGroups`. @param {any} ir */
export function orbitGroupsOf(ir) {
  return (ir?.groups ?? []).filter((/** @type {string} */ g) => g.startsWith('celestrak.'));
}

/** @param {unknown} node */
export function usesAudio(node) {
  if (!isNode(node)) return false;
  if (AUDIO_OPS.has(node.op)) return true;
  return node.args.some(usesAudio);
}

/**
 * Layer properties that the page evaluates on sky events: expressions without `audio.*` ops.
 * @param {any} layer
 * @returns {string[]}
 */
export function skyDrivenProps(layer) {
  return Object.entries(layer?.props ?? {}).filter(([, v]) => isNode(v) && !usesAudio(v)).map(([k]) => k);
}

/**
 * Layer properties that the renderer evaluates each frame (`frameValues`): expressions with
 * `audio.*` ops.
 * @param {any} layer
 * @returns {string[]}
 */
export function audioDrivenProps(layer) {
  return Object.entries(layer?.props ?? {}).filter(([, v]) => usesAudio(v)).map(([k]) => k);
}

/**
 * Evaluates the selected layer properties of every layer (doc/visuals.md, `LayerValues`);
 * by default the sky-driven ones, for `setLayerValues`.
 * @param {any} ir
 * @param {{ get(group: string): any[] }} sky
 * @param {(layer: any, obj: any) => Record<string, unknown>} layerProps the runtime's `layerProps`
 * @param {(layer: any) => string[]} [select]
 * @returns {Record<string, Record<string, unknown>>}
 */
export function computeLayerValues(ir, sky, layerProps, select = skyDrivenProps) {
  /** @type {Record<string, Record<string, unknown>>} */
  const out = {};
  for (const layer of ir?.layers ?? []) {
    const props = select(layer);
    if (!props.length) continue;
    const sub = { ...layer, props: Object.fromEntries(props.map((p) => [p, layer.props[p]])) };
    /** @type {Record<string, unknown>} */
    const values = {};
    if (layer.group) {
      /** @type {Record<string, Record<string, unknown>>} */
      const per = Object.fromEntries(props.map((p) => [p, {}]));
      for (const obj of sky.get(layer.group)) {
        const v = layerProps(sub, obj);
        for (const p of props) if (v[p] !== null && v[p] !== undefined) per[p][obj.id] = v[p];
      }
      Object.assign(values, per);
    } else {
      const v = layerProps(sub, null);
      for (const p of props) if (v[p] !== null && v[p] !== undefined) values[p] = v[p];
    }
    out[layer.id] = values;
  }
  return out;
}

/**
 * The evaluated view background when it is an expression; null otherwise.
 * @param {any} ir
 * @param {(layer: any, obj: any) => Record<string, unknown>} layerProps
 */
export function backgroundValue(ir, layerProps) {
  const bg = ir?.view?.background;
  if (!isNode(bg) || usesAudio(bg)) return null;
  const v = layerProps({ id: 'view', type: 'view', group: null, props: { background: bg } }, null).background;
  return typeof v === 'string' ? v : null;
}

/**
 * Builder errors block Save and Run; warnings do not (doc/piece-dsl.md, Type checking).
 * @param {{ severity: string }[]} problems
 */
export function blocking(problems) {
  return problems.some((p) => p.severity === 'error');
}
