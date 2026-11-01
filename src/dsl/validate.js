// IR validator (doc/piece-dsl.md, Validation). Runs the size and nesting checks, the schema
// check (ir.schema.json), then the semantic checks. Every problem carries a JSON Pointer into the
// IR. The validator alone decides whether a piece runs.

import schema from './ir.schema.json' with { type: 'json' };
import { checkSchema } from './schema-check.js';
import { own } from './defs.js';
import { problem } from './problem-codes.js';
import { parseSwpcPath } from '../expr/deps.js';
import { collectGroups, escapePointer, forEachExprPosition, forEachNode, isNode, objectGroup } from './ir-walk.js';
import {
  COLOR_HEX, CURRENT_IR_VERSION, CURVES, EVENT_KINDS, HANDLER_EVENTS, HANDLER_KINDS, LFO_SHAPES, LIMITS, NOTE_ROOT,
  ORBIT_QUANTITIES, PROGRAM, PROJECTIONS, RANGES, REACTION_KINDS, SCALE_MODES,
} from './limits.js';

/** @typedef {import('./problem-codes.js').Problem} Problem */
/** @typedef {import('./defs.js').Defs} Defs */
/** @typedef {import('./ir-walk.js').ExprContext} ExprContext */

/**
 * Argument kinds per op: 'value' is a number or node, 'any' also allows text, booleans and null,
 * 'string', 'number' and 'idOrNull' are constants.
 * @type {Record<string, string[]>}
 */
export const OPS = {
  field: ['string'], num: ['number'], rand: ['number', 'number'], swpc: ['string'], value: ['string', 'string'],
  count: ['string'], mean: ['string', 'string'], spread: ['string', 'string'],
  map: ['value', 'number', 'number', 'number', 'number', 'string'], clamp: ['value', 'number', 'number'],
  octaveInto: ['value', 'number', 'number'], quantize: ['value'],
  add: ['value', 'value'], sub: ['value', 'value'], mul: ['value', 'value'], div: ['value', 'value'],
  abs: ['value'], neg: ['value'], round: ['value'],
  eq: ['any', 'any'], gt: ['value', 'value'], lt: ['value', 'value'],
  and: ['any', 'any'], or: ['any', 'any'], not: ['any'],
  level: ['string'], spectrum: ['string', 'number'], env: ['string'],
  orbit: ['string', 'idOrNull', 'number'], local: ['string'],
  color: ['string'], mix: ['any', 'any', 'value'],
};

const AUDIO_OPS = new Set(['level', 'spectrum', 'env']);

/**
 * @param {unknown} ir
 * @param {Defs} defs
 * @param {{ snapshot?: Record<string, { fields: Record<string, unknown> }[]> }} [opts]
 *   `snapshot` holds the last objects per group; a field present in any of them is known.
 * @returns {Problem[]}
 */
export function validateIr(ir, defs, { snapshot } = {}) {
  /** @type {Problem[]} */
  const out = [];
  if (typeof ir !== 'object' || ir === null || Array.isArray(ir)) return [problem('ir_schema', '', 'The IR must be an object')];
  const doc = /** @type {any} */ (ir);
  if (Number.isInteger(doc.irVersion) && doc.irVersion > CURRENT_IR_VERSION) {
    return [problem('ir_version_unsupported', '/irVersion', `IR version ${doc.irVersion} is newer than this app supports (${CURRENT_IR_VERSION})`)];
  }
  if (doc.irVersion !== CURRENT_IR_VERSION) {
    return [problem('ir_schema', '/irVersion', `IR version must be ${CURRENT_IR_VERSION}; migrate older versions first`)];
  }

  const deep = findDeepPath(ir, 2 * LIMITS.exprDepth + 24);
  if (deep !== null) return [problem('expr_too_deep', deep, `An expression nests more than ${LIMITS.exprDepth} levels`)];

  const bytes = byteLength(JSON.stringify(ir));
  if (bytes > LIMITS.irBytes) {
    out.push(problem('ir_too_large', '', `The compiled piece is ${Math.ceil(bytes / 1024)} KB; the limit is ${LIMITS.irBytes / 1024} KB`));
  }

  const schemaErrors = checkSchema(schema, ir);
  if (schemaErrors.length) return [...out, ...schemaErrors.map((e) => problem('ir_schema', e.path, `IR ${e.path || 'document'} ${e.message}`))];

  new Checker(doc, defs, snapshot ?? {}, out).run();
  return out;
}

class Checker {
  /** @param {any} ir @param {Defs} defs @param {Record<string, any[]>} snapshot @param {Problem[]} out */
  constructor(ir, defs, snapshot, out) {
    this.ir = ir;
    this.defs = defs;
    this.snapshot = snapshot;
    this.out = out;
    /** @type {Map<string, any>} */ this.insts = new Map();
    /** @type {Map<string, any>} */ this.slots = new Map();
    /** @type {Map<string, any>} */ this.lfos = new Map();
    /** @type {Map<string, string>} orbit source key → first path */ this.orbitSources = new Map();
    this.usesFn = false;
  }

  /** @param {string} code @param {string} path @param {string} message */
  add(code, path, message) {
    this.out.push(problem(code, path, message));
  }

  /** @param {number} v @param {readonly number[]} range @param {string} path @param {string} name */
  range(v, range, path, name) {
    if (v < range[0] || v > range[1]) this.add('ir_schema', path, `${name} must be ${range[0]}–${range[1]}`);
  }

  run() {
    const { ir } = this;
    this.range(ir.tempo, RANGES.tempo, '/tempo', 'tempo');
    if (!NOTE_ROOT.test(ir.scale.root)) this.add('ir_schema', '/scale/root', `Unknown scale root ${ir.scale.root}`);
    if (!SCALE_MODES.includes(ir.scale.mode)) this.add('ir_schema', '/scale/mode', `Unknown scale mode ${ir.scale.mode}`);
    this.instruments();
    this.chains();
    this.lfoList();
    this.modList();
    this.bindings();
    this.reactions();
    this.view();
    this.layers();
    this.program();
    this.expressions();
    this.groupList();
    this.localOnly();
  }

  instruments() {
    const { ir, defs } = this;
    if (ir.instruments.length > LIMITS.instruments) {
      this.add('limit_instruments', `/instruments/${LIMITS.instruments}`, `A piece holds at most ${LIMITS.instruments} instruments`);
    }
    ir.instruments.forEach((inst, k) => {
      const p = `/instruments/${k}`;
      if (this.insts.has(inst.id)) this.add('ir_schema', `${p}/id`, `Duplicate instrument id ${inst.id}`);
      this.insts.set(inst.id, inst);
      const spec = own(defs.instruments, inst.type);
      if (!spec) { this.add('ir_schema', `${p}/type`, `Unknown instrument type ${inst.type}`); return; }
      const t = defs.tuning;
      this.range(inst.volumeDb, [t.volume.min, t.volume.max], `${p}/volumeDb`, 'volume');
      this.range(inst.octave, [t.octave.min, t.octave.max], `${p}/octave`, 'octave');
      this.range(inst.cents, [t.cents.min, t.cents.max], `${p}/cents`, 'cents');
      for (const [name, v] of Object.entries(inst.params)) {
        const pp = `${p}/params/${escapePointer(name)}`;
        const def = own(spec.params, name);
        if (!def) { this.add('unknown_option', pp, `${inst.type} has no parameter ${name}`); continue; }
        if (inst.type === 'granular' && name === 'source' && v === 'sample') {
          this.add('granular_sample', pp, "Pieces cannot load audio files; use source 'saw', 'noise' or 'chord'");
          continue;
        }
        this.paramValue(def, v, pp, `${inst.type}.${name}`, 'name');
      }
    });
  }

  /**
   * @param {import('./defs.js').ParamSpec} def @param {unknown} v @param {string} path @param {string} name
   * @param {'name' | 'index'} enumAs
   */
  paramValue(def, v, path, name, enumAs) {
    if (def.kind === 'number') {
      if (typeof v !== 'number') this.add('ir_schema', path, `${name} must be a number`);
      else this.range(v, [def.min, def.max], path, name);
    } else if (def.kind === 'enum') {
      const opts = /** @type {string[]} */ (def.options);
      const ok = enumAs === 'name' ? typeof v === 'string' && opts.includes(v) : Number.isInteger(v) && /** @type {number} */ (v) >= 0 && /** @type {number} */ (v) < opts.length;
      if (!ok) this.add('ir_schema', path, `${name} must be ${enumAs === 'name' ? 'one of' : 'an index into'} ${opts.join(', ')}`);
    } else if (!Array.isArray(v) || v.length !== def.length || !v.every((x) => typeof x === 'number' && x >= def.min && x <= def.max)) {
      this.add('ir_schema', path, `${name} must be ${def.length} numbers, each ${def.min}–${def.max}`);
    }
  }

  chains() {
    const { ir, defs } = this;
    /** @type {[any[], string][]} */
    const chains = [...ir.instruments.map((/** @type {any} */ inst, /** @type {number} */ k) => [inst.fx, `/instruments/${k}/fx`]), [ir.master.fx, '/master/fx']];
    let reverbs = 0;
    for (const [chain, base] of chains) {
      if (chain.length > LIMITS.slotsPerChain) {
        this.add('limit_slots', `${base}/${LIMITS.slotsPerChain}`, `A chain holds at most ${LIMITS.slotsPerChain} effects`);
      }
      chain.forEach((slot, j) => {
        const p = `${base}/${j}`;
        if (this.slots.has(slot.id)) {
          this.add('slot_reused', p, `Effect ${slot.type} (${slot.id}) is already in another chain; create a second effect`);
          return;
        }
        this.slots.set(slot.id, slot);
        const spec = own(defs.effects, slot.type);
        if (!spec) { this.add('ir_schema', `${p}/type`, `Unknown effect type ${slot.type}`); return; }
        if (slot.type === 'reverb' && ++reverbs === LIMITS.reverbs + 1) {
          this.add('limit_reverbs', p, `A piece holds at most ${LIMITS.reverbs} reverbs`);
        }
        for (const [name, v] of Object.entries(slot.params)) {
          const pp = `${p}/params/${escapePointer(name)}`;
          const def = own(spec.params, name);
          if (!def) this.add('unknown_option', pp, `${slot.type} has no parameter ${name}`);
          else this.paramValue(def, v, pp, `${slot.type}.${name}`, 'index');
        }
      });
    }
  }

  lfoList() {
    const { ir } = this;
    if (ir.lfos.length > LIMITS.lfos) this.add('limit_lfos', `/lfos/${LIMITS.lfos}`, `A piece holds at most ${LIMITS.lfos} LFOs`);
    ir.lfos.forEach((l, i) => {
      const p = `/lfos/${i}`;
      if (this.lfos.has(l.id)) this.add('ir_schema', `${p}/id`, `Duplicate LFO id ${l.id}`);
      this.lfos.set(l.id, l);
      if (!LFO_SHAPES.includes(l.shape)) this.add('ir_schema', `${p}/shape`, `Unknown LFO shape ${l.shape}`);
      this.range(l.phase, RANGES.lfoPhase, `${p}/phase`, 'phase');
      this.range(l.smooth, RANGES.lfoSmooth, `${p}/smooth`, 'smooth');
      const r = l.rate;
      if (typeof r === 'number') this.range(r, RANGES.lfoRate, `${p}/rate`, 'LFO rate');
      else if ('sync' in r) {
        if (!this.defs.syncNames.includes(r.sync)) this.add('ir_schema', `${p}/rate/sync`, `Unknown sync value ${r.sync}`);
      } else {
        if (r.expr.op !== 'map' && r.expr.op !== 'clamp') {
          this.add('lfo_rate_range', `${p}/rate/expr`, 'An LFO rate expression must end in .map(...) or .clamp(...)');
        }
        this.range(r.min, RANGES.lfoRate, `${p}/rate/min`, 'LFO rate');
        this.range(r.max, RANGES.lfoRate, `${p}/rate/max`, 'LFO rate');
        // The runtime needs a non-empty range (src/bind/mod-config.js); equal ends would divide by zero.
        if (!(r.min < r.max)) this.add('lfo_rate_range', `${p}/rate`, `The LFO rate range ${r.min}–${r.max} Hz is empty; its low end must be below its high end`);
      }
    });
  }

  /**
   * Resolves `<id>.<param>` against instruments and placed slots.
   * @param {string} id @param {string} param @param {string} path
   * @returns {import('./defs.js').ParamSpec | null}
   */
  targetParam(id, param, path) {
    const inst = this.insts.get(id);
    const slot = this.slots.get(id);
    const owner = inst ?? slot;
    if (!owner) {
      if (/^f\d+$/.test(id)) this.add('slot_unplaced', path, `Effect ${id} is in no chain; pass it to inst.fx(...) or master.fx(...)`);
      else this.add('ir_reference', path, `No instrument or effect ${id}`);
      return null;
    }
    const spec = inst ? own(this.defs.instruments, inst.type) : own(this.defs.effects, slot.type);
    if (!spec) return null;
    const def = own(spec.params, param);
    if (!def) { this.add('unknown_option', path, `${owner.type} has no parameter ${param}`); return null; }
    return def;
  }

  modList() {
    const { ir } = this;
    if (ir.mods.length > LIMITS.routes) this.add('limit_routes', `/mods/${LIMITS.routes}`, `A piece holds at most ${LIMITS.routes} modulation routes`);
    /** @type {Map<string, number>} */ const perTarget = new Map();
    /** @type {Map<string, Set<string>>} */ const retrigger = new Map();
    ir.mods.forEach((m, i) => {
      const p = `/mods/${i}`;
      this.range(m.depth, RANGES.depth, `${p}/depth`, 'depth');
      this.range(m.smoothMs, RANGES.smoothMs, `${p}/smoothMs`, 'smoothMs');
      const dot = m.target.indexOf('.');
      const id = m.target.slice(0, dot);
      const param = m.target.slice(dot + 1);
      const def = this.targetParam(id, param, `${p}/target`);
      if (def && !def.modulatable) {
        this.add('not_modulatable', `${p}/target`, `${param} cannot be modulated; use follow()`);
      }
      const n = (perTarget.get(m.target) ?? 0) + 1;
      perTarget.set(m.target, n);
      if (n === LIMITS.routesPerTarget + 1) {
        this.add('limit_routes_per_target', p, `A parameter takes at most ${LIMITS.routesPerTarget} modulation routes`);
      }
      if ('lfo' in m.source) {
        const l = this.lfos.get(m.source.lfo);
        if (!l) this.add('ir_reference', `${p}/source/lfo`, `No LFO ${m.source.lfo}`);
        else if (l.retrigger && this.insts.has(id)) {
          const set = retrigger.get(id) ?? new Set();
          set.add(l.id);
          retrigger.set(id, set);
          if (set.size === LIMITS.retriggerLfosPerInstrument + 1) {
            this.add('limit_retrigger_lfos', p, `An instrument takes at most ${LIMITS.retriggerLfosPerInstrument} retrigger LFOs`);
          }
        }
      }
    });
  }

  bindings() {
    const { ir } = this;
    if (ir.bindings.length > LIMITS.bindings) {
      this.add('limit_bindings', `/bindings/${LIMITS.bindings}`, `A piece holds at most ${LIMITS.bindings} bindings`);
    }
    ir.bindings.forEach((b, i) => {
      const p = `/bindings/${i}`;
      if (b.kind === 'voices' || b.kind === 'trigger') {
        const inst = this.insts.get(b.inst);
        if (!inst) this.add('ir_reference', `${p}/inst`, `No instrument ${b.inst}`);
        this.group(b.group, `${p}/group`);
        if (b.select !== null) {
          const cap = inst?.type === 'granular' ? LIMITS.voicesPerBindingGranular : LIMITS.voicesPerBinding;
          if (b.kind === 'voices' && b.select.top > cap) {
            this.add('limit_voices', `${p}/select/top`, `${inst?.type ?? 'An instrument'} plays at most ${cap} voices per binding`);
          }
          if (b.select.top < 1) this.add('ir_schema', `${p}/select/top`, 'top must be at least 1');
          if (b.select.order !== 'asc' && b.select.order !== 'desc') this.add('ir_schema', `${p}/select/order`, "order must be 'asc' or 'desc'");
          this.fieldName(b.group, b.select.by, `${p}/select/by`);
        }
        if (b.kind === 'trigger') {
          if (!EVENT_KINDS.includes(b.event)) this.add('ir_schema', `${p}/event`, `Unknown event kind ${b.event}`);
          this.range(b.durationMs, RANGES.durationMs, `${p}/durationMs`, 'durationMs');
          this.range(b.maxPerSecond, RANGES.maxPerSecond, `${p}/maxPerSecond`, 'maxPerSecond');
        }
        this.constRange(b.pitch, RANGES.pitch, `${p}/pitch`, 'pitch');
        this.constRange(b.velocity, RANGES.velocity, `${p}/velocity`, 'velocity');
        if (b.kind === 'voices') {
          this.constRange(b.pan, RANGES.pan, `${p}/pan`, 'pan');
          this.voiceMods(b, inst, p);
        }
      } else if (b.kind === 'param' || b.kind === 'fxParam') {
        const owner = b.kind === 'param' ? b.inst : b.slot;
        if (b.kind === 'param' && !this.insts.has(owner)) this.add('ir_reference', `${p}/inst`, `No instrument ${owner}`);
        else {
          const def = this.targetParam(owner, b.param, `${p}/param`);
          if (def?.kind === 'array') this.add('not_numeric', `${p}/param`, `${b.param} is a list; set it in the constructor`);
        }
        this.range(b.smoothMs, RANGES.smoothMs, `${p}/smoothMs`, 'smoothMs');
      } else if (!this.slots.has(b.slot)) {
        this.add('slot_unplaced', `${p}/slot`, `Effect ${b.slot} is in no chain; pass it to inst.fx(...) or master.fx(...)`);
      }
    });
  }

  /**
   * `voiceMods` names are modulatable parameters of the instrument; constant values lie in −1 to 1.
   * @param {any} b @param {any} inst @param {string} p
   */
  voiceMods(b, inst, p) {
    const spec = inst ? own(this.defs.instruments, inst.type) : undefined;
    for (const [name, v] of Object.entries(b.voiceMods)) {
      const pp = `${p}/voiceMods/${escapePointer(name)}`;
      if (spec && !own(spec.params, name)?.modulatable) {
        this.add('unknown_option', pp, `voiceMods: ${name} is not a modulatable parameter of ${inst.type}`);
      }
      this.constRange(v, RANGES.voiceMod, pp, `voiceMods.${name}`);
    }
  }

  /** @param {unknown} v @param {readonly number[]} range @param {string} path @param {string} name */
  constRange(v, range, path, name) {
    if (typeof v === 'number') this.range(v, range, path, name);
    else if (typeof v === 'string' || typeof v === 'boolean') this.add('ir_schema', path, `${name} must be a number or an expression`);
  }

  reactions() {
    this.ir.reactions.forEach((r, i) => {
      const p = `/reactions/${i}`;
      if (!REACTION_KINDS.includes(r.on)) this.add('ir_schema', `${p}/on`, `Unknown reaction ${r.on}`);
      if (r.source !== '*' && !own(this.defs.groups, r.source) && !this.defs.sources.includes(r.source)) {
        this.add('unknown_group', `${p}/source`, `No source or group ${r.source}`);
      }
      const a = r.actions;
      if (a.detuneCents !== undefined) this.range(a.detuneCents, RANGES.detuneCents, `${p}/actions/detuneCents`, 'detuneCents');
      if (a.desaturate !== undefined) this.range(a.desaturate, RANGES.desaturate, `${p}/actions/desaturate`, 'desaturate');
      for (const k of ['mute', 'only']) {
        (a[k] ?? []).forEach((/** @type {string} */ id, /** @type {number} */ j) => {
          if (!this.insts.has(id)) this.add('ir_reference', `${p}/actions/${k}/${j}`, `No instrument ${id}`);
        });
      }
    });
  }

  view() {
    if (!PROJECTIONS.includes(this.ir.view.projection)) this.add('ir_schema', '/view/projection', `Unknown projection ${this.ir.view.projection}`);
    this.colorConst(this.ir.view.background, '/view/background');
  }

  /** @param {unknown} v @param {string} path */
  colorConst(v, path) {
    if (typeof v === 'string' && !COLOR_HEX.test(v)) this.add('ir_schema', path, "A colour must look like '#rrggbb'");
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) this.add('ir_schema', path, 'A colour must be text or a colour expression');
  }

  layers() {
    const { ir, defs } = this;
    if (ir.layers.length > LIMITS.layers) this.add('limit_layers', `/layers/${LIMITS.layers}`, `A piece holds at most ${LIMITS.layers} layers`);
    ir.layers.forEach((l, i) => {
      const p = `/layers/${i}`;
      if (l.type === 'shader') {
        if (typeof l.glsl !== 'string') this.add('ir_schema', `${p}/glsl`, 'A shader layer needs glsl text');
        if (l.group !== null) this.add('ir_schema', `${p}/group`, 'A shader layer takes no group');
        return;
      }
      if ('glsl' in l) this.add('ir_schema', `${p}/glsl`, 'Only shader layers take glsl');
      const spec = own(defs.layers, l.type);
      if (!spec) { this.add('ir_schema', `${p}/type`, `Unknown layer type ${l.type}`); return; }
      if (spec.group) {
        if (l.group === null) this.add('ir_schema', `${p}/group`, `layer.${l.type} needs a group`);
        else this.group(l.group, `${p}/group`);
        if (l.select !== null && l.group !== null) this.fieldName(l.group, l.select.by, `${p}/select/by`);
      } else if (l.group !== null) this.add('ir_schema', `${p}/group`, `layer.${l.type} takes no group`);
      for (const [name, v] of Object.entries(l.props)) {
        const pp = `${p}/props/${escapePointer(name)}`;
        const def = own(spec.props, name);
        if (!def) { this.add('unknown_option', pp, `layer.${l.type} has no property ${name}`); continue; }
        if (isNode(v)) continue;
        if (def.type === 'number') {
          if (typeof v !== 'number') this.add('ir_schema', pp, `${name} must be a number or an expression`);
          else this.range(v, [/** @type {number} */ (def.min), /** @type {number} */ (def.max)], pp, name);
        } else if (def.type === 'color') this.colorConst(v, pp);
        else if (def.type === 'enum') {
          if (!def.options?.includes(/** @type {string} */ (v))) this.add('ir_schema', pp, `${name} must be one of ${def.options?.join(', ')}`);
        } else if (typeof v !== 'string' || (def.maxLength !== null && [...v].length > def.maxLength)) {
          this.add('ir_schema', pp, `${name} must be text${def.maxLength !== null ? ` of at most ${def.maxLength} characters` : ''}`);
        }
      }
    });
  }

  /** Registered handlers and followed groups (doc/piece-dsl.md, Program). */
  program() {
    const pr = this.ir.program;
    if (pr === undefined) return;
    if (pr.handlers.length > LIMITS.handlers) this.add('limit_handlers', `/program/handlers/${LIMITS.handlers}`, `A piece registers at most ${LIMITS.handlers} handlers`);
    pr.handlers.forEach((/** @type {any} */ h, /** @type {number} */ i) => {
      const p = `/program/handlers/${i}`;
      if (h.id !== `h${i}`) this.add('ir_reference', `${p}/id`, `Handler ${i} must have id h${i}`);
      if (!HANDLER_KINDS.includes(h.kind)) { this.add('ir_schema', `${p}/kind`, `Unknown handler kind ${h.kind}`); return; }
      const keys = { on: ['group', 'event'], every: h.sync !== undefined ? ['sync'] : ['intervalMs'], after: ['ms'], freshness: ['source'] }[/** @type {'on'} */ (h.kind)];
      for (const k of Object.keys(h)) if (k !== 'id' && k !== 'kind' && !keys.includes(k)) this.add('ir_schema', `${p}/${k}`, `A ${h.kind} handler takes no ${k}`);
      for (const k of keys) if (h[k] === undefined) this.add('ir_schema', `${p}/${k}`, `A ${h.kind} handler needs ${k}`);
      if (h.kind === 'on') {
        if (typeof h.group === 'string') this.group(h.group, `${p}/group`);
        if (!HANDLER_EVENTS.includes(h.event)) this.add('ir_schema', `${p}/event`, `event must be one of ${HANDLER_EVENTS.join(', ')}`);
      } else if (h.kind === 'every') {
        if (h.sync !== undefined) {
          if (!this.defs.syncNames.includes(h.sync)) this.add('ir_schema', `${p}/sync`, `Unknown sync value ${h.sync}`);
        } else if (typeof h.intervalMs !== 'number') this.add('ir_schema', `${p}/intervalMs`, 'intervalMs must be a number');
        else this.range(h.intervalMs, PROGRAM.intervalMs, `${p}/intervalMs`, 'intervalMs');
      } else if (h.kind === 'after') {
        if (typeof h.ms !== 'number') this.add('ir_schema', `${p}/ms`, 'ms must be a number');
        else this.range(h.ms, PROGRAM.afterMs, `${p}/ms`, 'ms');
      } else if (typeof h.source !== 'string' || !h.source) this.add('ir_schema', `${p}/source`, 'source must be text');
      else if (h.source !== '*' && !this.defs.sources.includes(h.source) && !own(this.defs.groups, h.source)) {
        this.add('unknown_group', `${p}/source`, `No source or group ${h.source}`);
      }
    });
    pr.follow.forEach((/** @type {string} */ g, /** @type {number} */ i) => this.group(g, `/program/follow/${i}`));
    (pr.orbits ?? []).forEach((/** @type {any} */ n, /** @type {number} */ i) => {
      if (n?.op !== 'orbit' || typeof n.args?.[1] !== 'string') this.add('ir_schema', `/program/orbits/${i}`, 'A program orbit must be sky.orbit(objectId, quantity)');
    });
  }

  /** @param {string} key @param {string} path @returns {boolean} */
  group(key, path) {
    if (own(this.defs.groups, key)) return true;
    this.add('unknown_group', path, `No group ${key}`);
    return false;
  }

  /** Warns when no definition or snapshot object of `group` has `name`. @param {string} group @param {string} name @param {string} path */
  fieldName(group, name, path) {
    const g = own(this.defs.groups, group);
    if (!g) return;
    if (own(g.fields, name)) return;
    const objs = own(this.snapshot, group) ?? [];
    if (objs.some((o) => o?.fields && Object.prototype.hasOwnProperty.call(o.fields, name))) return;
    this.add('unknown_field', path, `No object of ${group} has the field ${name}`);
  }

  expressions() {
    forEachExprPosition(this.ir, (value, path, ctx) => this.expression(value, path, ctx));
    if (this.orbitSources.size > LIMITS.orbitSources) {
      const path = [...this.orbitSources.values()][LIMITS.orbitSources];
      this.add('limit_orbit_sources', path, `A piece uses at most ${LIMITS.orbitSources} orbit sources`);
    }
  }

  /** @param {unknown} value @param {string} path @param {ExprContext} ctx */
  expression(value, path, ctx) {
    let tooDeep = false;
    forEachNode(value, path, (node, p, depth) => {
      if (depth > LIMITS.exprDepth) {
        if (!tooDeep) this.add('expr_too_deep', p, `An expression nests more than ${LIMITS.exprDepth} levels`);
        tooDeep = true;
        return;
      }
      this.node(node, p, ctx);
    }, LIMITS.exprDepth + 1);
  }

  /** @param {{ op: string, args: any[] }} node @param {string} p @param {ExprContext} ctx */
  node(node, p, ctx) {
    const kinds = own(OPS, node.op);
    if (!kinds) { this.add('ir_schema', `${p}/op`, `Unknown op ${node.op}`); return; }
    if (node.args.length !== kinds.length) {
      this.add('ir_schema', `${p}/args`, `${node.op} takes ${kinds.length} argument${kinds.length === 1 ? '' : 's'}`);
      return;
    }
    for (let i = 0; i < kinds.length; i++) {
      const a = node.args[i];
      const ok = kinds[i] === 'any' ? true
        : kinds[i] === 'value' ? typeof a === 'number' || isNode(a)
          : kinds[i] === 'idOrNull' ? a === null || typeof a === 'string'
            : typeof a === kinds[i];
      if (!ok) { this.add('ir_schema', `${p}/args/${i}`, `Argument ${i} of ${node.op} must be ${kinds[i]}`); return; }
    }
    const a = node.args;
    switch (node.op) {
      case 'field':
        if (ctx.object !== null) this.fieldName(ctx.object, a[0], `${p}/args/0`);
        break;
      case 'swpc': {
        const sp = parseSwpcPath(a[0]);
        if (!sp) { this.add('unknown_group', `${p}/args/0`, `sky.swpc path ${a[0]} must look like 'kp.kp'`); break; }
        if (this.group(sp.group, `${p}/args/0`)) this.fieldName(sp.group, sp.field, `${p}/args/0`);
        break;
      }
      case 'value': {
        const g = objectGroup(a[0]);
        if (this.group(g, `${p}/args/0`)) this.fieldName(g, a[1], `${p}/args/1`);
        break;
      }
      case 'count':
        this.group(a[0], `${p}/args/0`);
        break;
      case 'mean': case 'spread':
        if (this.group(a[0], `${p}/args/0`)) this.fieldName(a[0], a[1], `${p}/args/1`);
        break;
      case 'map':
        if (!CURVES.includes(a[5])) this.add('ir_schema', `${p}/args/5`, `Unknown curve ${a[5]}`);
        break;
      case 'level': case 'spectrum': case 'env':
        if (!ctx.layer) this.add('audio_outside_layer', p, `audio.${node.op === 'env' ? 'voice(...).env' : node.op}() works in layer properties only`);
        if (!this.insts.has(a[0])) this.add('ir_reference', `${p}/args/0`, `No instrument ${a[0]}`);
        if (node.op === 'spectrum') this.range(a[1], RANGES.spectrumBands, `${p}/args/1`, 'bands');
        break;
      case 'local':
        this.usesFn = true;
        if (ctx.layer) this.add('fn_in_layer', p, 'fn() is not allowed in layer properties; use expression steps');
        break;
      case 'color':
        if (!COLOR_HEX.test(a[0])) this.add('ir_schema', `${p}/args/0`, "A colour must look like '#rrggbb'");
        break;
      case 'orbit':
        this.orbit(a, p, ctx);
        break;
      default:
    }
  }

  /** @param {any[]} a @param {string} p @param {ExprContext} ctx */
  orbit(a, p, ctx) {
    const [quantity, objectId, timeScale] = a;
    if (!ORBIT_QUANTITIES.includes(quantity)) {
      this.add('orbit_quantity', `${p}/args/0`, `Unknown orbit quantity ${quantity}; use ${ORBIT_QUANTITIES.join(', ')}`);
    }
    this.range(timeScale, RANGES.timeScale, `${p}/args/2`, 'timeScale');
    let group;
    if (objectId === null) {
      if (ctx.object === null) {
        this.add('orbit_no_object', p, 'orbit(...) needs a current object; use sky.orbit(objectId, quantity) here');
        return;
      }
      group = ctx.object;
    } else {
      group = objectGroup(objectId);
      if (!this.group(group, `${p}/args/1`)) return;
    }
    const g = own(this.defs.groups, group);
    if (g && !g.orbit) {
      this.add('orbit_no_elements', p, `${group} has no orbital elements; orbits apply to celestrak.* groups`);
      return;
    }
    const key = `${objectId ?? `${group}:*`}|${quantity}|${timeScale}`;
    if (!this.orbitSources.has(key)) this.orbitSources.set(key, p);
  }

  /** `groups` lists exactly the referenced groups; each reference is checked where it occurs. */
  groupList() {
    const listed = new Set(this.ir.groups);
    const used = new Set(collectGroups(this.ir));
    for (const g of used) if (!listed.has(g)) this.add('ir_reference', '/groups', `groups must list ${g}`);
    this.ir.groups.forEach((/** @type {string} */ g, /** @type {number} */ i) => {
      if (!used.has(g)) this.add('ir_reference', `/groups/${i}`, `groups lists ${g}, which nothing references`);
    });
  }

  localOnly() {
    const needed = this.usesFn || this.ir.layers.some((/** @type {any} */ l) => l.type === 'shader');
    if (needed && !this.ir.localOnly) this.add('ir_schema', '/localOnly', 'A piece with fn() or layer.shader must set localOnly');
    if (needed) this.add('local_only', '/localOnly', 'This piece uses fn() or layer.shader: it runs in your editor and cannot be shared');
  }
}

/** First JSON Pointer at which `value` nests deeper than `max`, or null. @param {unknown} value @param {number} max */
function findDeepPath(value, max) {
  /** @type {[unknown, string, number][]} */
  const stack = [[value, '', 0]];
  while (stack.length) {
    const [v, p, d] = /** @type {[any, string, number]} */ (stack.pop());
    if (typeof v !== 'object' || v === null) continue;
    if (d > max) return p;
    for (const [k, c] of Object.entries(v)) stack.push([c, `${p}/${escapePointer(k)}`, d + 1]);
  }
  return null;
}

/** UTF-8 length of a string. @param {string} s */
function byteLength(s) {
  return new TextEncoder().encode(s).length;
}
