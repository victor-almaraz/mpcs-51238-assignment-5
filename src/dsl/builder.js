// The global builder API (doc/piece-dsl.md, Builder API; doc/visuals.md, Builder API).
// `createBuilder(defs)` returns the API object a script sees and a `finish()` that returns the IR.
// The builder records what the script asks for, coerces constants into their ranges, and leaves
// reference, limit and context rules to the validator (validate.js), which reports them with
// JSON Pointers. Argument shapes the IR cannot represent throw a TypeError (problem runtime_error).

import { ColorExpr, Expr, expr, finite, isExpr, toValue } from './expr.js';
import { collectGroups, forEachNode } from './ir-walk.js';
import { own } from './defs.js';
import {
  COLOR_HEX, CURRENT_IR_VERSION, DEFAULTS, EVENT_KINDS, LFO_SHAPES, NOTE_ROOT, PROJECTIONS, RANGES, SCALE_MODES,
} from './limits.js';

/** @typedef {import('./defs.js').Defs} Defs */
/** @typedef {import('./defs.js').ParamSpec} ParamSpec */
/** @typedef {import('./expr.js').Value} Value */

/** Handle property names that never denote a parameter. */
const RESERVED = new Set(['then', 'toJSON', 'toString', 'valueOf', 'constructor', '__proto__', 'prototype', 'inspect', 'nodeType', '$$typeof']);

/**
 * @param {Defs} defs
 * @param {{ line?: () => number | null }} [opts] `line` returns the script line of the current builder call
 */
export function createBuilder(defs, { line = () => null } = {}) {
  /** @type {WeakMap<object, any>} handle → internal record */
  const records = new WeakMap();
  /** @type {Record<string, number | null>} JSON Pointer → script line */
  const lines = {};

  const st = {
    seed: DEFAULTS.seed,
    tempo: DEFAULTS.tempo,
    scale: { root: DEFAULTS.root, mode: DEFAULTS.mode },
    /** @type {any[]} */ instruments: [],
    master: { kind: 'master', fx: /** @type {any[]} */ ([]), fxLine: /** @type {number | null} */ (null) },
    slotCount: 0,
    /** @type {any[]} */ lfos: [],
    /** @type {any[]} */ mods: [],
    /** @type {any[]} */ bindings: [],
    /** @type {any[]} */ reactions: [],
    view: { projection: DEFAULTS.projection, background: /** @type {Value} */ (DEFAULTS.background) },
    /** @type {any[]} */ layers: [],
    localOnly: false,
  };

  // ---------- helpers ----------
  /** @param {string} pointer @param {number | null} ln */
  const mark = (pointer, ln) => { lines[pointer] = ln; };

  /** @param {unknown} v @param {string} where */
  const plainObject = (v, where) => {
    if (v === undefined) return {};
    if (typeof v !== 'object' || v === null || Array.isArray(v) || isExpr(v)) throw new TypeError(`${where}: options must be an object`);
    return /** @type {Record<string, unknown>} */ (v);
  };

  /** @param {unknown} v @param {[number, number]} range @param {string} where @param {string} name */
  const clampNum = (v, range, where, name) => clamp(finite(v, where, name), range[0], range[1]);

  /** @param {unknown} handle @param {string} where */
  const instrumentOf = (handle, where) => {
    const rec = typeof handle === 'object' && handle !== null ? records.get(handle) : undefined;
    if (!rec || rec.kind !== 'instrument') throw new TypeError(`${where}: expected an instrument such as additive({...})`);
    return rec;
  };

  /** Keeps a JSON value as given so the validator can report it; drops anything else. @param {unknown} v */
  const jsonish = (v) => (isExpr(v) ? v.node : v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint' ? null : v);

  /**
   * Coerces an initial parameter value (doc/audio/patch-format.md, coerce): numbers clamp to
   * [min, max]; enums take an option name (instrument) or index (effect); arrays take `length` numbers.
   * @param {ParamSpec} p @param {unknown} v @param {string} where @param {string} name @param {'name' | 'index'} enumAs
   */
  const coerceParam = (p, v, where, name, enumAs) => {
    if (p.kind === 'number') return clampNum(v, [p.min, p.max], where, name);
    if (p.kind === 'enum') {
      const opts = /** @type {string[]} */ (p.options);
      let i = typeof v === 'string' ? opts.indexOf(v) : Number.isInteger(v) ? /** @type {number} */ (v) : -1;
      if (i < 0 || i >= opts.length) throw new TypeError(`${where}: ${name} must be one of ${opts.map((o) => `'${o}'`).join(', ')}`);
      return enumAs === 'name' ? opts[i] : i;
    }
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      throw new TypeError(`${where}: ${name} must be a list of ${p.length} numbers`);
    }
    const out = v.slice(0, /** @type {number} */ (p.length)).map((x) => clamp(x, p.min, p.max));
    while (out.length < /** @type {number} */ (p.length)) out.push(0);
    return out;
  };

  /** Resolves an options argument that may be a function of the object proxy. @param {unknown} opts @param {string | null} group @param {string} where */
  const resolveOpts = (opts, group, where) => {
    const v = typeof opts === 'function' ? opts(group === null ? undefined : objectProxy(group)) : opts;
    return plainObject(v, where);
  };

  /** @param {Record<string, unknown>} o @param {string[]} allowed @param {string} where */
  const onlyKeys = (o, allowed, where) => {
    for (const k of Object.keys(o)) {
      if (!allowed.includes(k)) throw new TypeError(`${where}: unknown option '${k}'; options are ${allowed.join(', ')}`);
    }
  };

  // ---------- expressions ----------
  /** @param {string} name */
  const field = (name) => {
    if (typeof name !== 'string' || !name) throw new TypeError('field(): name must be text');
    return expr('field', [name]);
  };

  /** @param {unknown} opts @param {string} where */
  const timeScaleOf = (opts, where) => {
    const o = plainObject(opts, where);
    onlyKeys(o, ['timeScale'], where);
    return o.timeScale === undefined ? DEFAULTS.timeScale : clampNum(o.timeScale, /** @type {[number, number]} */ (RANGES.timeScale), where, 'timeScale');
  };

  /** @param {unknown} quantity @param {unknown} [opts] */
  const orbit = (quantity, opts) => {
    if (typeof quantity !== 'string') throw new TypeError('orbit(): quantity must be text');
    return expr('orbit', [quantity, null, timeScaleOf(opts, 'orbit()')]);
  };

  /** @param {string} group */
  const objectProxy = (group) => {
    const hasOrbit = own(defs.groups, group)?.orbit ?? group.startsWith('celestrak.');
    return new Proxy(Object.create(null), {
      get(_, k) {
        if (typeof k === 'symbol') return undefined;
        if (k === 'orbit' && hasOrbit) return orbit;
        return field(k);
      },
      set() { throw new TypeError('object proxies are read-only'); },
    });
  };

  // ---------- parameters ----------
  /**
   * @param {{ kind: 'instrument' | 'slot', id: string }} owner
   * @param {string} name
   */
  const paramHandle = (owner, name) => Object.freeze({
    /** @param {unknown} value @param {unknown} [opts] */
    follow(value, opts) {
      const ln = line();
      const where = `${name}.follow()`;
      const o = plainObject(opts, where);
      onlyKeys(o, ['smoothMs'], where);
      const smoothMs = o.smoothMs === undefined ? DEFAULTS.smoothMs : clampNum(o.smoothMs, /** @type {[number, number]} */ (RANGES.smoothMs), where, 'smoothMs');
      const id = `b${st.bindings.length}`;
      const b = owner.kind === 'instrument'
        ? { id, kind: 'param', inst: owner.id, param: name, expr: toValue(value, where), smoothMs }
        : { id, kind: 'fxParam', slot: owner.id, param: name, expr: toValue(value, where), smoothMs };
      mark(`/bindings/${st.bindings.length}`, ln);
      st.bindings.push(b);
    },
    /** @param {unknown} source @param {unknown} opts */
    mod(source, opts) {
      const ln = line();
      const where = `${name}.mod()`;
      const o = plainObject(opts, where);
      onlyKeys(o, ['depth', 'smoothMs'], where);
      if (o.depth === undefined) throw new TypeError(`${where}: depth is required, for example { depth: 0.1 }`);
      const depth = clampNum(o.depth, /** @type {[number, number]} */ (RANGES.depth), where, 'depth');
      const rec = typeof source === 'object' && source !== null ? records.get(source) : undefined;
      let src;
      let orbitSource = false;
      if (rec?.kind === 'lfo') src = { lfo: rec.id };
      else if (source instanceof Expr) {
        src = { expr: source.node };
        forEachNode(source.node, '', (n) => { if (n.op === 'orbit') orbitSource = true; });
      } else throw new TypeError(`${where}: source must be an lfo(...) or an expression`);
      const dflt = orbitSource ? DEFAULTS.orbitSmoothMs : DEFAULTS.smoothMs;
      const smoothMs = o.smoothMs === undefined ? dflt : clampNum(o.smoothMs, /** @type {[number, number]} */ (RANGES.smoothMs), where, 'smoothMs');
      mark(`/mods/${st.mods.length}`, ln);
      st.mods.push({ target: `${owner.id}.${name}`, source: src, depth, smoothMs });
    },
  });

  /** @param {{ kind: 'slot', id: string }} owner */
  const bypassHandle = (owner) => Object.freeze({
    /** @param {unknown} value */
    follow(value) {
      const ln = line();
      mark(`/bindings/${st.bindings.length}`, ln);
      st.bindings.push({ id: `b${st.bindings.length}`, kind: 'fxBypass', slot: owner.id, expr: toValue(value, 'bypass.follow()') });
    },
    mod() { throw new TypeError('bypass accepts follow() only'); },
  });

  /** @param {any} rec @param {(name: string) => unknown} special */
  const handleProxy = (rec, special) => {
    const cache = new Map();
    const handle = new Proxy(Object.create(null), {
      get(_, k) {
        if (typeof k === 'symbol' || RESERVED.has(k)) return undefined;
        const s = special(k);
        if (s !== undefined) return s;
        if (!cache.has(k)) cache.set(k, paramHandle(rec, k));
        return cache.get(k);
      },
      set() { throw new TypeError('handles are read-only'); },
    });
    records.set(handle, rec);
    return handle;
  };

  // ---------- chains ----------
  /** @param {any} owner @param {unknown[]} slots @param {string} where */
  const setChain = (owner, slots, where) => {
    const ln = line();
    owner.fx = slots.map((s) => {
      const rec = typeof s === 'object' && s !== null ? records.get(s) : undefined;
      if (!rec || rec.kind !== 'slot') throw new TypeError(`${where}: expected effects such as reverb({...})`);
      return rec;
    });
    owner.fxLine = ln;
  };

  // ---------- instruments ----------
  /** @param {string} type */
  const instrumentFactory = (type) => (/** @type {unknown} */ opts) => {
    const ln = line();
    const where = `${type}()`;
    const o = plainObject(opts, where);
    const spec = defs.instruments[type];
    const t = defs.tuning;
    const rec = {
      kind: 'instrument', id: `i${st.instruments.length}`, type,
      volumeDb: t.volume.default, octave: t.octave.default, cents: t.cents.default,
      params: /** @type {Record<string, unknown>} */ ({}), fx: /** @type {any[]} */ ([]), fxLine: /** @type {number | null} */ (null), line: ln,
    };
    for (const [k, v] of Object.entries(o)) {
      if (k === 'volume') rec.volumeDb = clampNum(v, [t.volume.min, t.volume.max], where, 'volume');
      else if (k === 'octave') rec.octave = Math.round(clampNum(v, [t.octave.min, t.octave.max], where, 'octave'));
      else if (k === 'cents') rec.cents = clampNum(v, [t.cents.min, t.cents.max], where, 'cents');
      else {
        const p = own(spec.params, k);
        rec.params[k] = p ? coerceParam(p, v, where, k, 'name') : jsonish(v);
      }
    }
    mark(`/instruments/${st.instruments.length}`, ln);
    st.instruments.push(rec);
    return handleProxy(rec, (k) => (k === 'fx' ? (/** @type {unknown[]} */ ...slots) => setChain(rec, slots, `${type}.fx()`) : undefined));
  };

  // ---------- effects ----------
  /** @param {string} type */
  const effectFactory = (type) => (/** @type {unknown} */ opts) => {
    const ln = line();
    const where = `${type}()`;
    const o = plainObject(opts, where);
    const spec = defs.effects[type];
    const rec = { kind: 'slot', id: `f${st.slotCount++}`, type, params: /** @type {Record<string, unknown>} */ ({}), bypass: false, line: ln };
    for (const [k, v] of Object.entries(o)) {
      if (k === 'bypass') {
        if (typeof v !== 'boolean') throw new TypeError(`${where}: bypass must be true or false`);
        rec.bypass = v;
      } else {
        const p = own(spec.params, k);
        rec.params[k] = p ? coerceParam(p, v, where, k, 'index') : jsonish(v);
      }
    }
    let bypass;
    return handleProxy(rec, (k) => (k === 'bypass' ? (bypass ??= bypassHandle(rec)) : undefined));
  };

  // ---------- LFOs ----------
  /** @param {unknown} opts */
  const lfo = (opts) => {
    const ln = line();
    const where = 'lfo()';
    const o = plainObject(opts, where);
    onlyKeys(o, ['shape', 'rate', 'phase', 'retrigger', 'smooth'], where);
    const shape = o.shape ?? DEFAULTS.lfoShape;
    if (typeof shape !== 'string' || !LFO_SHAPES.includes(shape)) throw new TypeError(`${where}: shape must be one of ${LFO_SHAPES.join(', ')}`);
    /** @type {any} */
    let rate = DEFAULTS.lfoRate;
    const [rmin, rmax] = RANGES.lfoRate;
    if (typeof o.rate === 'number') rate = clampNum(o.rate, [rmin, rmax], where, 'rate');
    else if (typeof o.rate === 'string') {
      if (!defs.syncNames.includes(o.rate)) throw new TypeError(`${where}: rate '${o.rate}' is not a sync value; use ${defs.syncNames.join(', ')}`);
      rate = { sync: o.rate };
    } else if (o.rate instanceof Expr) {
      const n = o.rate.node;
      const [lo, hi] = n.op === 'map' ? [n.args[3], n.args[4]] : n.op === 'clamp' ? [n.args[1], n.args[2]] : [rmin, rmax];
      const a = clamp(Math.min(Number(lo), Number(hi)), rmin, rmax);
      const b = clamp(Math.max(Number(lo), Number(hi)), rmin, rmax);
      rate = { expr: n, min: a, max: b };
    } else if (o.rate !== undefined) throw new TypeError(`${where}: rate must be a number in Hz, a sync value or an expression`);
    const phase = o.phase === undefined ? DEFAULTS.lfoPhase : clampNum(o.phase, /** @type {[number, number]} */ (RANGES.lfoPhase), where, 'phase');
    if (o.retrigger !== undefined && typeof o.retrigger !== 'boolean') throw new TypeError(`${where}: retrigger must be true or false`);
    const smooth = o.smooth === undefined ? (shape === 'smooth' ? 0.5 : 0) : clampNum(o.smooth, /** @type {[number, number]} */ (RANGES.lfoSmooth), where, 'smooth');
    const rec = { kind: 'lfo', id: `lfo${st.lfos.length}` };
    mark(`/lfos/${st.lfos.length}`, ln);
    st.lfos.push({ id: rec.id, shape, rate, phase, retrigger: o.retrigger === true, smooth });
    const handle = Object.freeze(Object.create(null));
    records.set(handle, rec);
    return handle;
  };

  // ---------- sky ----------
  /** @param {string} key @param {{ top: number, by: string, order: string } | null} select */
  const groupHandle = (key, select) => {
    const handle = Object.freeze({
      /** @param {unknown} n @param {unknown} by @param {unknown} [order] */
      top(n, by, order = DEFAULTS.selectOrder) {
        const top = Math.max(1, Math.floor(finite(n, 'top', 'n')));
        if (typeof by !== 'string') throw new TypeError('top(): field must be text');
        if (order !== 'asc' && order !== 'desc') throw new TypeError("top(): order must be 'asc' or 'desc'");
        return groupHandle(key, { top, by, order });
      },
      /** @param {unknown} inst @param {unknown} opts */
      voices(inst, opts) {
        const ln = line();
        const where = 'voices()';
        const rec = instrumentOf(inst, where);
        const o = resolveOpts(opts, key, where);
        onlyKeys(o, ['pitch', 'velocity', 'pan', 'voiceMods'], where);
        if (o.pitch === undefined) throw new TypeError(`${where}: pitch is required`);
        const mods = plainObject(o.voiceMods, `${where} voiceMods`);
        mark(`/bindings/${st.bindings.length}`, ln);
        st.bindings.push({
          id: `b${st.bindings.length}`, kind: 'voices', inst: rec.id, group: key, select,
          pitch: constRange(o.pitch, RANGES.pitch, `${where} pitch`),
          velocity: o.velocity === undefined ? DEFAULTS.velocity : constRange(o.velocity, RANGES.velocity, `${where} velocity`),
          pan: o.pan === undefined ? DEFAULTS.pan : constRange(o.pan, RANGES.pan, `${where} pan`),
          voiceMods: Object.fromEntries(Object.entries(mods).map(([k, v]) => [k, toValue(v, `${where} voiceMods.${k}`)])),
        });
      },
      /** @param {unknown} kind */
      on(kind) {
        if (typeof kind !== 'string' || !EVENT_KINDS.includes(kind)) throw new TypeError(`on(): kind must be one of ${EVENT_KINDS.join(', ')}`);
        return eventHandle(key, select, kind, null);
      },
      count() { return expr('count', [key]); },
      /** @param {unknown} f */
      mean(f) { return expr('mean', [key, fieldName(f, 'mean')]); },
      /** @param {unknown} f */
      spread(f) { return expr('spread', [key, fieldName(f, 'spread')]); },
    });
    records.set(handle, { kind: 'group', key, select });
    return handle;
  };

  /** @param {string} key @param {any} select @param {string} kind @param {Value} when */
  const eventHandle = (key, select, kind, when) => Object.freeze({
    /** @param {unknown} cond */
    when(cond) {
      const v = typeof cond === 'function' ? cond(objectProxy(key)) : cond;
      const node = toValue(v, 'when()');
      return eventHandle(key, select, kind, when === null ? node : { op: 'and', args: [when, node] });
    },
    /** @param {unknown} inst @param {unknown} opts */
    trigger(inst, opts) {
      const ln = line();
      const where = 'trigger()';
      const rec = instrumentOf(inst, where);
      const o = resolveOpts(opts, key, where);
      onlyKeys(o, ['pitch', 'velocity', 'durationMs', 'maxPerSecond'], where);
      if (o.pitch === undefined) throw new TypeError(`${where}: pitch is required`);
      mark(`/bindings/${st.bindings.length}`, ln);
      st.bindings.push({
        id: `b${st.bindings.length}`, kind: 'trigger', inst: rec.id, group: key, select, event: kind, when,
        pitch: constRange(o.pitch, RANGES.pitch, `${where} pitch`),
        velocity: o.velocity === undefined ? DEFAULTS.velocity : constRange(o.velocity, RANGES.velocity, `${where} velocity`),
        durationMs: o.durationMs === undefined ? DEFAULTS.durationMs : clampNum(o.durationMs, /** @type {[number, number]} */ (RANGES.durationMs), where, 'durationMs'),
        maxPerSecond: o.maxPerSecond === undefined ? DEFAULTS.maxPerSecond : clampNum(o.maxPerSecond, /** @type {[number, number]} */ (RANGES.maxPerSecond), where, 'maxPerSecond'),
      });
    },
  });

  /** @param {unknown} key */
  const groupOf = (key) => {
    if (typeof key !== 'string' || !key) throw new TypeError('sky.group(): key must be text');
    return groupHandle(key, null);
  };

  const sky = Object.freeze({
    group: groupOf,
    /** @param {unknown} path */
    swpc(path) {
      if (typeof path !== 'string') throw new TypeError("sky.swpc(): path must be text such as 'kp.kp'");
      return expr('swpc', [path]);
    },
    /** @param {unknown} objectId @param {unknown} f */
    value(objectId, f) {
      if (typeof objectId !== 'string') throw new TypeError('sky.value(): objectId must be text');
      return expr('value', [objectId, fieldName(f, 'sky.value')]);
    },
    /** @param {unknown} objectId @param {unknown} quantity @param {unknown} [opts] */
    orbit(objectId, quantity, opts) {
      if (typeof objectId !== 'string') throw new TypeError('sky.orbit(): objectId must be text');
      if (typeof quantity !== 'string') throw new TypeError('sky.orbit(): quantity must be text');
      return expr('orbit', [quantity, objectId, timeScaleOf(opts, 'sky.orbit()')]);
    },
  });

  // ---------- reactions ----------
  /** @param {'stale' | 'down'} on */
  const reaction = (on) => (/** @type {unknown} */ source, /** @type {unknown} */ actions) => {
    const ln = line();
    const where = on === 'stale' ? 'onStale()' : 'onDown()';
    if (typeof source !== 'string') throw new TypeError(`${where}: source must be a source id, a group or '*'`);
    const a = plainObject(actions, where);
    onlyKeys(a, ['detuneCents', 'mute', 'only', 'desaturate'], where);
    /** @type {Record<string, unknown>} */
    const out = {};
    if (a.detuneCents !== undefined) out.detuneCents = clampNum(a.detuneCents, /** @type {[number, number]} */ (RANGES.detuneCents), where, 'detuneCents');
    for (const k of ['mute', 'only']) {
      if (a[k] === undefined) continue;
      if (!Array.isArray(a[k])) throw new TypeError(`${where}: ${k} must be a list of instruments`);
      out[k] = /** @type {unknown[]} */ (a[k]).map((h) => instrumentOf(h, `${where} ${k}`).id);
    }
    if (a.desaturate !== undefined) out.desaturate = clampNum(a.desaturate, /** @type {[number, number]} */ (RANGES.desaturate), where, 'desaturate');
    mark(`/reactions/${st.reactions.length}`, ln);
    st.reactions.push({ on, source, actions: out });
  };

  // ---------- visuals ----------
  const view = Object.freeze({
    /** @param {unknown} p */
    projection(p) {
      mark('/view/projection', line());
      if (typeof p !== 'string' || !PROJECTIONS.includes(p)) throw new TypeError(`view.projection(): use one of ${PROJECTIONS.join(', ')}`);
      st.view.projection = p;
    },
    /** @param {unknown} c */
    background(c) {
      mark('/view/background', line());
      st.view.background = layerValue({ type: 'color' }, c, 'view.background()');
    },
  });

  /**
   * @param {{ type: string, min?: number | null, max?: number | null, options?: string[] | null, maxLength?: number | null }} spec
   * @param {unknown} v @param {string} where
   * @returns {Value}
   */
  const layerValue = (spec, v, where) => {
    if (isExpr(v)) return v.node;
    switch (spec.type) {
      case 'number': return clampNum(v, [/** @type {number} */ (spec.min), /** @type {number} */ (spec.max)], where, 'value');
      case 'color':
        if (typeof v !== 'string' || !COLOR_HEX.test(v)) throw new TypeError(`${where}: colour must look like '#rrggbb'`);
        return v;
      case 'enum':
        if (typeof v !== 'string' || !spec.options?.includes(v)) throw new TypeError(`${where}: use one of ${spec.options?.join(', ')}`);
        return v;
      default:
        if (typeof v !== 'string') throw new TypeError(`${where}: value must be text`);
        if (spec.maxLength !== null && spec.maxLength !== undefined && [...v].length > spec.maxLength) {
          throw new TypeError(`${where}: at most ${spec.maxLength} character${spec.maxLength === 1 ? '' : 's'}`);
        }
        return v;
    }
  };

  /** @param {string} type */
  const layerFactory = (type) => {
    const spec = defs.layers[type];
    /** @param {string | null} group @param {any} select @param {unknown} props @param {number | null} ln */
    const add = (group, select, props, ln) => {
      const where = `layer.${type}()`;
      const o = resolveOpts(props, group, where);
      /** @type {Record<string, Value>} */
      const out = {};
      for (const [k, v] of Object.entries(o)) {
        const p = own(spec.props, k);
        out[k] = p ? layerValue(p, v, `${where} ${k}`) : /** @type {Value} */ (jsonish(v));
      }
      for (const k of spec.order) if (!(k in out)) out[k] = /** @type {Value} */ (spec.props[k].default);
      mark(`/layers/${st.layers.length}`, ln);
      st.layers.push({ id: `l${st.layers.length}`, type, group, select, props: out });
    };
    if (spec.group) {
      return (/** @type {unknown} */ g, /** @type {unknown} */ props) => {
        const ln = line();
        const rec = typeof g === 'object' && g !== null ? records.get(g) : undefined;
        if (!rec || rec.kind !== 'group') throw new TypeError(`layer.${type}(): first argument must be sky.group(...)`);
        add(rec.key, rec.select, props, ln);
      };
    }
    return (/** @type {unknown} */ props) => add(null, null, props, line());
  };

  /** @type {Record<string, Function>} */
  const layer = {};
  for (const type of Object.keys(defs.layers)) layer[type] = layerFactory(type);
  /** @param {unknown} glsl @param {unknown} props */
  layer.shader = (glsl, props) => {
    const ln = line();
    if (typeof glsl !== 'string') throw new TypeError('layer.shader(): glsl must be text');
    const o = plainObject(props, 'layer.shader()');
    st.localOnly = true;
    /** @type {Record<string, Value>} */
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      const p = own(defs.shaderProps, k);
      out[k] = p ? layerValue(p, v, `layer.shader() ${k}`) : toValue(v, `layer.shader() ${k}`);
    }
    for (const [k, p] of Object.entries(defs.shaderProps)) if (!(k in out)) out[k] = /** @type {Value} */ (p.default);
    mark(`/layers/${st.layers.length}`, ln);
    st.layers.push({ id: `l${st.layers.length}`, type: 'shader', group: null, select: null, glsl, props: out });
  };
  Object.freeze(layer);

  /** @param {unknown} inst @param {string} where */
  const instId = (inst, where) => instrumentOf(inst, where).id;
  const audio = Object.freeze({
    /** @param {unknown} inst */
    level: (inst) => expr('level', [instId(inst, 'audio.level()')]),
    /** @param {unknown} inst @param {unknown} bands */
    spectrum: (inst, bands) => expr('spectrum', [instId(inst, 'audio.spectrum()'),
      Math.round(clampNum(bands, /** @type {[number, number]} */ (RANGES.spectrumBands), 'audio.spectrum()', 'bands'))]),
    /** @param {unknown} inst */
    voice: (inst) => {
      const id = instId(inst, 'audio.voice()');
      return Object.freeze({ env: () => expr('env', [id]) });
    },
  });

  // ---------- API ----------
  /** @type {Record<string, unknown>} */
  const api = {
    /** @param {unknown} root @param {unknown} mode */
    scale(root, mode) {
      mark('/scale', line());
      if (typeof root !== 'string' || !NOTE_ROOT.test(root)) throw new TypeError("scale(): root must be a note name such as 'D' or 'F#'");
      if (typeof mode !== 'string' || !SCALE_MODES.includes(mode)) throw new TypeError(`scale(): mode must be one of ${SCALE_MODES.join(', ')}`);
      st.scale = { root, mode };
    },
    /** @param {unknown} n */
    seed(n) {
      mark('/seed', line());
      if (!Number.isSafeInteger(n)) throw new TypeError('seed(): n must be an integer');
      st.seed = /** @type {number} */ (n);
    },
    /** @param {unknown} bpm */
    tempo(bpm) {
      mark('/tempo', line());
      st.tempo = clampNum(bpm, /** @type {[number, number]} */ (RANGES.tempo), 'tempo()', 'bpm');
    },
    master: Object.freeze({ fx: (/** @type {unknown[]} */ ...slots) => setChain(st.master, slots, 'master.fx()') }),
    lfo,
    sky,
    field,
    /** @param {unknown} x */
    num: (x) => expr('num', [finite(x, 'num', 'x')]),
    /** @param {unknown} lo @param {unknown} hi */
    rand: (lo, hi) => expr('rand', [finite(lo, 'rand', 'lo'), finite(hi, 'rand', 'hi')]),
    orbit,
    onStale: reaction('stale'),
    onDown: reaction('down'),
    view,
    layer,
    /** @param {unknown} hex */
    color: (hex) => {
      if (typeof hex !== 'string' || !COLOR_HEX.test(hex)) throw new TypeError("color(): use a colour such as '#ffcc00'");
      return new ColorExpr({ op: 'color', args: [hex] });
    },
    audio,
    /** @param {unknown} source */
    fn: (source) => {
      if (typeof source !== 'string') throw new TypeError("fn(): source must be text such as 'o => o.fields.inclination / 2'");
      st.localOnly = true;
      return expr('local', [source]);
    },
  };
  for (const type of Object.keys(defs.instruments)) {
    if (type in api) throw new Error(`instrument type ${type} collides with a builder name`);
    api[type] = instrumentFactory(type);
  }
  for (const type of Object.keys(defs.effects)) {
    if (type in api) throw new Error(`effect type ${type} collides with a builder name`);
    api[type] = effectFactory(type);
  }
  Object.freeze(api);

  /** @param {any} slot */
  const slotIr = (slot) => ({ id: slot.id, type: slot.type, params: { ...slot.params }, bypass: slot.bypass });

  /** @param {any} owner @param {string} base */
  const chainIr = (owner, base) => {
    if (owner.fxLine !== null) mark(base, owner.fxLine);
    return owner.fx.map((/** @type {any} */ s, /** @type {number} */ j) => {
      if (owner.fxLine !== null) mark(`${base}/${j}`, owner.fxLine);
      mark(`${base}/${j}/params`, s.line);
      return slotIr(s);
    });
  };

  /** @returns {{ ir: any, lines: Record<string, number | null> }} */
  function finish() {
    const ir = {
      irVersion: CURRENT_IR_VERSION,
      seed: st.seed,
      tempo: st.tempo,
      scale: { ...st.scale },
      instruments: st.instruments.map((r, k) => ({
        id: r.id, type: r.type, volumeDb: r.volumeDb, octave: r.octave, cents: r.cents,
        params: { ...r.params }, fx: chainIr(r, `/instruments/${k}/fx`),
      })),
      master: { fx: chainIr(st.master, '/master/fx') },
      lfos: st.lfos,
      mods: st.mods,
      bindings: st.bindings,
      reactions: st.reactions,
      view: { ...st.view },
      layers: st.layers,
      groups: /** @type {string[]} */ ([]),
      localOnly: st.localOnly,
    };
    ir.groups = collectGroups(ir);
    return { ir: structuredCloneJson(ir), lines };
  }

  return { api, finish };
}

/** Constants in note, velocity and pan positions clamp to their range; expressions pass through. */
function constRange(/** @type {unknown} */ v, /** @type {readonly number[]} */ range, /** @type {string} */ where) {
  if (typeof v === 'number') return clamp(finite(v, where, 'value'), range[0], range[1]);
  return toValue(v, where);
}

/** @param {unknown} f @param {string} where */
function fieldName(f, where) {
  if (typeof f !== 'string' || !f) throw new TypeError(`${where}(): field must be text`);
  return f;
}

/** @param {number} x @param {number} lo @param {number} hi */
function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/** Deep copy through JSON so the IR shares no objects with builder state. @param {unknown} v */
function structuredCloneJson(v) {
  return JSON.parse(JSON.stringify(v));
}

