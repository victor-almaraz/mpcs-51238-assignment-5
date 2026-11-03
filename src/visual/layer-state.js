/**
 * Layer state: IR layer normalization, hot-reload diffing, property
 * coercion and per-object property resolution (doc/visuals.md, Layer
 * properties and Interface). No WebGL or DOM.
 */
import { LAYER_DEFS } from './layer-defs.js';
import { isHexColor } from './color.js';
import { canonicalJson } from '../bind/canonical.js';

const AUDIO_OPS = new Set(['level', 'spectrum', 'env']);
/** Properties held while the flash guard intervenes. */
export const HELD_PROPS = Object.freeze(['color', 'opacity', 'background', 'cells', 'sizes']);

/**
 * @param {unknown} v
 * @returns {v is { op: string, args: unknown[] }}
 */
export function isExprNode(v) {
  return !!v && typeof v === 'object' && typeof /** @type {any} */ (v).op === 'string' && Array.isArray(/** @type {any} */ (v).args);
}

/**
 * True when an expression node contains an `audio.*` op.
 * @param {unknown} node
 * @returns {boolean}
 */
export function usesAudio(node) {
  if (!isExprNode(node)) return false;
  if (AUDIO_OPS.has(node.op)) return true;
  return node.args.some(usesAudio);
}

export { canonicalJson } from '../bind/canonical.js';

/**
 * Coerces a value to a property definition. Returns `undefined` for a value
 * that cannot be used, so the caller keeps the previous value.
 * @param {import('./layer-defs.js').PropDef} def
 * @param {unknown} value
 * @returns {number | string | (string | null)[] | (number | null)[] | undefined}
 */
export function coerceProp(def, value) {
  switch (def.type) {
    case 'numbers':
      // Entries that are not finite numbers become null, which the renderer draws at full size.
      if (!Array.isArray(value)) return undefined;
      return value.slice(0, def.length).map((x) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(def.max, Math.max(def.min, x)) : null));
    case 'colors':
      // Entries that are not colours become null, which the renderer draws as the background.
      if (!Array.isArray(value)) return undefined;
      return value.slice(0, def.max).map((c) => (isHexColor(c) ? /** @type {string} */ (c).toLowerCase() : null));
    case 'number': {
      if (typeof value === 'boolean') value = value ? 1 : 0;
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      return Math.min(def.max, Math.max(def.min, value));
    }
    case 'color':
      return isHexColor(value) ? /** @type {string} */ (value).toLowerCase() : undefined;
    case 'char': {
      if (typeof value !== 'string' || value.length === 0) return undefined;
      const first = String.fromCodePoint(/** @type {number} */ (value.codePointAt(0)));
      return first.trim() === '' ? undefined : first;
    }
    case 'enum': {
      if (typeof value === 'string') return def.options.includes(value) ? value : undefined;
      if (typeof value === 'number' && Number.isFinite(value)) {
        const i = Math.round(value);
        return i >= 0 && i < def.options.length ? def.options[i] : undefined;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * @typedef {{
 *   id: string, type: string, group: string | null, glsl: string | null,
 *   constants: Record<string, number | string>,
 *   exprProps: Set<string>, audioProps: Set<string>, key: string,
 * }} LayerState
 */

/**
 * Normalizes one IR layer. Returns an error string for an entry the
 * renderer cannot draw.
 * @param {any} entry
 * @returns {LayerState | string}
 */
export function normalizeLayer(entry) {
  if (!entry || typeof entry !== 'object') return 'layer entry is not an object';
  const def = LAYER_DEFS[entry.type];
  if (typeof entry.id !== 'string' || !entry.id) return 'layer id missing';
  if (!def) return `unknown layer type ${JSON.stringify(entry.type)}`;
  const group = def.group ? entry.group : null;
  if (def.group && (typeof group !== 'string' || !group)) return `layer ${entry.id} has no group`;
  if (entry.type === 'shader' && typeof entry.glsl !== 'string') return `layer ${entry.id} has no glsl`;
  /** @type {Record<string, number | string>} */
  const constants = {};
  const exprProps = new Set();
  const audioProps = new Set();
  const props = entry.props && typeof entry.props === 'object' ? entry.props : {};
  for (const [name, v] of Object.entries(props)) {
    const pdef = def.props[name];
    if (!pdef) continue;
    if (isExprNode(v)) {
      exprProps.add(name);
      if (usesAudio(v)) audioProps.add(name);
      continue;
    }
    const c = coerceProp(pdef, v);
    if (c !== undefined) constants[name] = c;
  }
  return {
    id: entry.id,
    type: entry.type,
    group,
    glsl: entry.type === 'shader' ? entry.glsl : null,
    constants,
    exprProps,
    audioProps,
    key: canonicalJson(entry),
  };
}

/**
 * Diffs the running layers against a new IR layer list by id and canonical
 * JSON (doc/piece-dsl.md, Hot reload, step 7).
 * @param {Map<string, LayerState>} running
 * @param {any[]} entries
 * @returns {{ layers: LayerState[], added: string[], changed: string[], removed: string[], unchanged: string[], errors: { index: number, message: string }[] }}
 */
export function diffLayers(running, entries) {
  /** @type {LayerState[]} */
  const layers = [];
  const added = [], changed = [], unchanged = [], errors = [];
  const seen = new Set();
  (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    const s = normalizeLayer(entry);
    if (typeof s === 'string') { errors.push({ index, message: s }); return; }
    if (seen.has(s.id)) { errors.push({ index, message: `duplicate layer id ${s.id}` }); return; }
    seen.add(s.id);
    const prev = running.get(s.id);
    if (!prev) added.push(s.id);
    else if (prev.key === s.key) { unchanged.push(s.id); layers.push(prev); return; }
    else changed.push(s.id);
    layers.push(s);
  });
  const removed = [...running.keys()].filter((id) => !seen.has(id));
  return { layers, added, changed, removed, unchanged, errors };
}

/**
 * Resolves layer property values per object, remembering the last valid
 * value of each (layer, object, property).
 */
export class PropResolver {
  constructor() {
    /** @type {Map<string, number | string>} */
    this.last = new Map();
    /** @type {Map<string, Set<string>>} memo keys of `last` per object id */
    this.byObject = new Map();
  }

  /**
   * @param {LayerState} layer
   * @param {string | null} objectId `null` for full-screen layers
   * @param {{ frame?: any, pushed?: any, reducedMotion?: boolean, holdColors?: boolean }} opts
   * @returns {Record<string, number | string>}
   */
  resolve(layer, objectId, { frame, pushed, reducedMotion = false, holdColors = false } = {}) {
    const def = LAYER_DEFS[layer.type];
    /** @type {Record<string, number | string>} */
    const out = {};
    for (const [name, pdef] of Object.entries(def.props)) {
      if (reducedMotion && pdef.type === 'number' && pdef.reducedMotion !== undefined) {
        out[name] = pdef.reducedMotion;
        continue;
      }
      // A constant property becomes driven once a program pushes a value for it (layerHandle.set).
      if (!layer.exprProps.has(name) && pushed?.[layer.id]?.[name] === undefined) {
        out[name] = layer.constants[name] ?? pdef.default;
        continue;
      }
      const memo = `${layer.id}\u0000${objectId ?? ''}\u0000${name}`;
      const held = holdColors && HELD_PROPS.includes(name) ? this.last.get(memo) : undefined;
      if (held !== undefined) { out[name] = held; continue; }
      let v = pick(frame, layer.id, name, objectId, pdef);
      if (v === undefined) v = pick(pushed, layer.id, name, objectId, pdef);
      if (v === undefined) v = this.last.get(memo);
      if (v === undefined) v = pdef.default;
      else this.remember(memo, objectId, v);
      out[name] = v;
    }
    return out;
  }

  /** @param {string} memo @param {string | null} objectId @param {number | string} v */
  remember(memo, objectId, v) {
    this.last.set(memo, v);
    if (objectId === null) return;
    let keys = this.byObject.get(objectId);
    if (!keys) { keys = new Set(); this.byObject.set(objectId, keys); }
    keys.add(memo);
  }

  /** Forgets remembered values of one layer, or of all layers. @param {string} [layerId] */
  forget(layerId) {
    if (layerId === undefined) { this.last.clear(); this.byObject.clear(); return; }
    const prefix = `${layerId}\u0000`;
    for (const k of this.last.keys()) if (k.startsWith(prefix)) this.last.delete(k);
    for (const [id, keys] of this.byObject) {
      for (const k of keys) if (k.startsWith(prefix)) keys.delete(k);
      if (!keys.size) this.byObject.delete(id);
    }
  }

  /** Forgets remembered values of one object in every layer, after its `exit`. @param {string} objectId */
  forgetObject(objectId) {
    const keys = this.byObject.get(objectId);
    if (!keys) return;
    for (const k of keys) this.last.delete(k);
    this.byObject.delete(objectId);
  }
}

/**
 * @param {any} values LayerValues
 * @param {string} layerId
 * @param {string} prop
 * @param {string | null} objectId
 * @param {import('./layer-defs.js').PropDef} pdef
 */
function pick(values, layerId, prop, objectId, pdef) {
  const v = values?.[layerId]?.[prop];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'object' && !Array.isArray(v)) {
    if (objectId === null || !Object.hasOwn(v, objectId)) return undefined;
    return coerceProp(pdef, v[objectId]);
  }
  return coerceProp(pdef, v);
}

/**
 * Sample-and-hold gate: while active, passes a new value at most once per
 * `periodMs` (reduced motion: data-driven changes at most 1 Hz).
 */
export class ValueGate {
  /** @param {number} periodMs */
  constructor(periodMs = 1000) {
    this.periodMs = periodMs;
    this.lastAt = -Infinity;
    /** @type {any} */
    this.held = undefined;
  }

  /**
   * @template T
   * @param {T} value
   * @param {number} nowMs
   * @param {boolean} active
   * @returns {T}
   */
  offer(value, nowMs, active) {
    if (!active) { this.held = value; this.lastAt = nowMs; return value; }
    if (this.held === undefined || nowMs - this.lastAt >= this.periodMs) {
      this.held = value;
      this.lastAt = nowMs;
    }
    return this.held;
  }
}
