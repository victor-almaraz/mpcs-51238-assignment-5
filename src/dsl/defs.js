// Normalizes the definition tables the DSL reads (PARAM_DEFS, TUNING_DEFS, the effect registry,
// LAYER_DEFS and groups.json) into one plain, structured-cloneable object. The builder, the
// validator, the sandbox and the type generator receive this object as an argument, so tests run
// with fixture tables and the sandbox receives the tables by postMessage.

import { DEFAULTS, RANGES } from './limits.js';

/**
 * @typedef {{
 *   kind: 'number' | 'enum' | 'array',
 *   min: number, max: number, default: number | string | number[],
 *   scale: string, step: number | null, unit: string, label: string,
 *   options: string[] | null, length: number | null,
 *   modulatable: boolean, dir: 'both' | 'down',
 * }} ParamSpec
 * @typedef {{ params: Record<string, ParamSpec>, order: string[] }} TypeSpec
 * @typedef {{ type: 'number' | 'color' | 'enum' | 'string', min: number | null, max: number | null,
 *   default: number | string, options: string[] | null, maxLength: number | null, unit: string }} LayerPropSpec
 * @typedef {{ group: boolean, props: Record<string, LayerPropSpec>, order: string[] }} LayerSpec
 * @typedef {{ fields: Record<string, { type: 'number' | 'string' | 'boolean', unit: string }>, orbit: boolean, source: string }} GroupSpec
 * @typedef {{ min: number, max: number, default: number }} RangeSpec
 * @typedef {{
 *   instruments: Record<string, TypeSpec>,
 *   effects: Record<string, TypeSpec>,
 *   tuning: { volume: RangeSpec, octave: RangeSpec, cents: RangeSpec },
 *   layers: Record<string, LayerSpec>,
 *   shaderProps: Record<string, LayerPropSpec>,
 *   groups: Record<string, GroupSpec>,
 *   sources: string[],
 *   syncNames: string[],
 * }} Defs
 */

/** Layer types drawn without a group when LAYER_DEFS does not say (doc/visuals.md, Builder API). */
const GROUPLESS_LAYERS = new Set(['field', 'aurora']);

/**
 * @param {{ paramDefs: any, tuningDefs?: any, effectRegistry: any, layerDefs: any, groups: any }} raw
 * @returns {Defs}
 */
export function normalizeDefs({ paramDefs, tuningDefs, effectRegistry, layerDefs, groups }) {
  if (!isObject(paramDefs)) throw new Error('normalizeDefs: PARAM_DEFS must be an object keyed by instrument type');
  if (!isObject(effectRegistry) && !(effectRegistry instanceof Map)) throw new Error('normalizeDefs: the effect registry must be an object keyed by effect type');
  if (!isObject(layerDefs)) throw new Error('normalizeDefs: LAYER_DEFS must be an object keyed by layer type');
  if (!isObject(groups)) throw new Error('normalizeDefs: groups.json must be an object keyed by group');

  const instruments = {};
  for (const [type, list] of Object.entries(paramDefs)) {
    instruments[type] = normalizeTypeSpec(`PARAM_DEFS.${type}`, list, 'synth');
  }
  const effects = {};
  const entries = effectRegistry instanceof Map ? [...effectRegistry.entries()] : Object.entries(effectRegistry);
  for (const [type, entry] of entries) {
    const list = Array.isArray(entry) ? entry : entry?.params ?? entry?.paramDefs ?? entry?.defs;
    effects[type] = normalizeTypeSpec(`effect registry ${type}`, list, 'effect');
  }

  const layers = {};
  const common = isObject(layerDefs.all) ? normalizeLayerProps('all', layerDefs.all.props ?? {}) : {};
  // `layer.shader(glsl, props)` is a builder of its own: its props are free uniforms, and the
  // declared shader props (opacity) only supply defaults.
  let shaderProps = { ...common };
  for (const [type, def] of Object.entries(layerDefs)) {
    if (type === 'all') continue;
    if (type === 'shader') {
      shaderProps = { ...common, ...normalizeLayerProps(type, def?.props ?? {}) };
      continue;
    }
    if (!isObject(def)) throw new Error(`normalizeDefs: LAYER_DEFS.${type} must be an object`);
    const props = { ...common, ...normalizeLayerProps(type, def.props ?? {}) };
    const group = typeof def.group === 'boolean' ? def.group : !GROUPLESS_LAYERS.has(type);
    layers[type] = { group, props, order: Object.keys(props) };
  }

  const groupSpecs = {};
  for (const [key, g] of Object.entries(groups)) {
    if (!isObject(g) || !isObject(g.fields)) throw new Error(`normalizeDefs: groups.json entry ${key} needs a fields object`);
    const fields = {};
    for (const [name, f] of Object.entries(g.fields)) {
      const type = f?.type;
      if (type !== 'number' && type !== 'string' && type !== 'boolean') {
        throw new Error(`normalizeDefs: groups.json ${key}.${name} needs type number, string or boolean`);
      }
      fields[name] = { type, unit: typeof f.unit === 'string' ? f.unit : '' };
    }
    groupSpecs[key] = {
      fields,
      orbit: typeof g.orbit === 'boolean' ? g.orbit : key.startsWith('celestrak.'),
      source: typeof g.source === 'string' ? g.source : key,
    };
  }

  const syncOptions = effects.delay?.params.sync?.options ?? [];
  return {
    instruments,
    effects,
    tuning: normalizeTuning(tuningDefs),
    layers,
    shaderProps,
    groups: groupSpecs,
    sources: [...new Set(Object.values(groupSpecs).map((g) => g.source))].sort(),
    syncNames: syncOptions.filter((o) => o !== 'off'),
  };
}

/**
 * @param {string} where
 * @param {any} list
 * @param {'synth' | 'effect'} family
 * @returns {TypeSpec}
 */
function normalizeTypeSpec(where, list, family) {
  if (!Array.isArray(list)) throw new Error(`normalizeDefs: ${where} must be a ParamDef list`);
  const params = {};
  for (const d of list) {
    const name = d?.name ?? d?.id;
    if (typeof name !== 'string' || !name) throw new Error(`normalizeDefs: ${where} has a ParamDef without name or id`);
    params[name] = normalizeParam(`${where}.${name}`, d, family);
  }
  return { params, order: Object.keys(params) };
}

/**
 * @param {string} where
 * @param {any} d
 * @param {'synth' | 'effect'} family
 * @returns {ParamSpec}
 */
function normalizeParam(where, d, family) {
  const options = Array.isArray(d.options) ? d.options.map(String) : null;
  const kind = options || d.scale === 'enum' ? 'enum' : Array.isArray(d.default) ? 'array' : 'number';
  if (kind === 'enum' && !options) throw new Error(`normalizeDefs: ${where} is an enum without options`);
  let def = d.default;
  if (kind === 'enum') {
    if (typeof def === 'number') def = options[def];
    if (!options.includes(def)) def = options[0];
  } else if (kind === 'array') {
    def = d.default.map(Number);
  } else if (!Number.isFinite(def)) {
    throw new Error(`normalizeDefs: ${where} needs a finite default`);
  }
  const min = kind === 'enum' ? 0 : Number(d.min);
  const max = kind === 'enum' ? options.length - 1 : Number(d.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new Error(`normalizeDefs: ${where} needs min <= max`);
  // Synth ParamDefs: an absent `mod` means null (doc/audio/synthesis-conventions.md).
  // Effect ParamDefs: modulatable unless `mod: null` ("set only"); `mod.dir` or `dir` 'down' marks "down".
  const mod = d.mod;
  const modulatable = kind === 'number' && (family === 'synth' ? isObject(mod) : mod !== null);
  const dir = (isObject(mod) && mod.dir === 'down') || d.dir === 'down' || d.down === true ? 'down' : 'both';
  return {
    kind,
    min,
    max,
    default: def,
    scale: typeof d.scale === 'string' ? d.scale : kind === 'enum' ? 'enum' : 'lin',
    step: Number.isFinite(d.step) ? d.step : null,
    unit: typeof d.unit === 'string' ? d.unit : '',
    label: typeof d.label === 'string' ? d.label : '',
    options,
    length: kind === 'array' ? d.default.length : null,
    modulatable,
    dir,
  };
}

/** @param {string} type @param {any} props @returns {Record<string, LayerPropSpec>} */
function normalizeLayerProps(type, props) {
  if (!isObject(props)) throw new Error(`normalizeDefs: LAYER_DEFS.${type}.props must be an object`);
  const out = {};
  for (const [name, p] of Object.entries(props)) {
    if (!isObject(p)) throw new Error(`normalizeDefs: LAYER_DEFS.${type}.props.${name} must be an object`);
    const options = Array.isArray(p.options) ? p.options.map(String) : null;
    const type2 = typeof p.type === 'string' && ['number', 'color', 'enum', 'string'].includes(p.type)
      ? p.type
      : p.type === 'colour' ? 'color'
        : p.type === 'char' ? 'string'
        : options ? 'enum'
          : typeof p.default === 'string' ? (p.default.startsWith('#') ? 'color' : 'string')
            : 'number';
    if (type2 === 'number' && (!Number.isFinite(p.min) || !Number.isFinite(p.max) || !Number.isFinite(p.default))) {
      throw new Error(`normalizeDefs: LAYER_DEFS.${type}.props.${name} needs numeric min, max and default`);
    }
    out[name] = {
      type: type2,
      min: type2 === 'number' ? p.min : null,
      max: type2 === 'number' ? p.max : null,
      default: p.default ?? (options ? options[0] : ''),
      options,
      maxLength: Number.isFinite(p.maxLength) ? p.maxLength : p.type === 'char' || (type2 === 'string' && name === 'char') ? 1 : null,
      unit: typeof p.unit === 'string' ? p.unit : '',
    };
  }
  return out;
}

/** @param {any} t */
function normalizeTuning(t) {
  /** @param {string} name @param {[number, number]} range @param {number} dflt */
  const pick = (name, range, dflt) => {
    const src = Array.isArray(t) ? t.find((d) => d?.name === name || d?.id === name) : t?.[name];
    return {
      min: Number.isFinite(src?.min) ? src.min : range[0],
      max: Number.isFinite(src?.max) ? src.max : range[1],
      default: Number.isFinite(src?.default) ? src.default : dflt,
    };
  };
  return {
    volume: { min: RANGES.volumeDb[0], max: RANGES.volumeDb[1], default: DEFAULTS.volumeDb },
    octave: pick('octave', RANGES.octave, DEFAULTS.octave),
    cents: pick('cents', RANGES.cents, DEFAULTS.cents),
  };
}

/** @param {unknown} v @returns {v is Record<string, any>} */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Own-property lookup that ignores prototype keys such as `__proto__` or `constructor`.
 * @template T
 * @param {Record<string, T>} obj
 * @param {string} key
 * @returns {T | undefined}
 */
export function own(obj, key) {
  return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}
