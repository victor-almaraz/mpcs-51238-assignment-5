// Generates builder.d.ts, the global builder API types (doc/piece-dsl.md, Types), from the
// normalized definition tables. The output depends only on `defs`, so generation is deterministic.
//
// Expression types carry a context parameter C: the contexts an expression needs.
//   'obj'   a current object (field, orbit, audio.voice(...).env)
//   'audio' a layer property (audio.*)
//   'fn'    a binding, where fn() is allowed
// Each position accepts the contexts it provides: follow, mod and LFO rates accept 'fn'; voice and
// trigger options accept 'obj' | 'fn'; layer properties accept 'obj' | 'audio' on group layers
// and 'audio' on full-screen layers and the view background.

import { CURVES, EVENT_KINDS, LFO_SHAPES, ORBIT_QUANTITIES, PROJECTIONS, SCALE_MODES } from './limits.js';
import { unitLabel } from './units.js';

/** @typedef {import('./defs.js').Defs} Defs */
/** @typedef {import('./defs.js').ParamSpec} ParamSpec */

const CORE = `type Ctx = 'obj' | 'audio' | 'fn';
/** Contexts of follow(), mod() and LFO rates. */
type GlobalCtx = 'fn';
/** Contexts of voice, trigger and when options. */
type ObjectCtx = 'obj' | 'fn';
/** Contexts of properties of layers drawn per object. */
type LayerCtx = 'obj' | 'audio';
/** Contexts of full-screen layer properties and the view background. */
type ScreenCtx = 'audio';

/** An expression producing a number. */
interface NumExpr<C extends Ctx = never> {
  readonly __type?: 'number';
  readonly __ctx?: C;
  /** Maps [inMin, inMax] onto [outMin, outMax] (curve 'lin', 'log' or 'exp'), clamped to the output range. */
  map(inMin: number, inMax: number, outMin: number, outMax: number, curve?: Curve): NumExpr<C>;
  /** Clamps the value to [lo, hi]. */
  clamp(lo: number, hi: number): NumExpr<C>;
  /** Treats the value as a frequency, folds it by octaves into [loHz, hiHz) and returns the MIDI pitch. */
  octaveInto(loHz: number, hiHz: number): NumExpr<C>;
  /** Nearest pitch in the piece scale. */
  quantize(): NumExpr<C>;
  add<D extends Ctx = never>(x: Num<D>): NumExpr<C | D>;
  sub<D extends Ctx = never>(x: Num<D>): NumExpr<C | D>;
  mul<D extends Ctx = never>(x: Num<D>): NumExpr<C | D>;
  div<D extends Ctx = never>(x: Num<D>): NumExpr<C | D>;
  abs(): NumExpr<C>;
  neg(): NumExpr<C>;
  round(): NumExpr<C>;
  eq<D extends Ctx = never>(x: Num<D>): BoolExpr<C | D>;
  gt<D extends Ctx = never>(x: Num<D>): BoolExpr<C | D>;
  lt<D extends Ctx = never>(x: Num<D>): BoolExpr<C | D>;
}

/** An expression producing text. */
interface StrExpr<C extends Ctx = never> {
  readonly __type?: 'string';
  readonly __ctx?: C;
  eq<D extends Ctx = never>(x: string | StrExpr<D>): BoolExpr<C | D>;
}

/** An expression producing true or false. */
interface BoolExpr<C extends Ctx = never> {
  readonly __type?: 'boolean';
  readonly __ctx?: C;
  and<D extends Ctx = never>(e: Cond<D>): BoolExpr<C | D>;
  or<D extends Ctx = never>(e: Cond<D>): BoolExpr<C | D>;
  not(): BoolExpr<C>;
  eq<D extends Ctx = never>(x: Cond<D>): BoolExpr<C | D>;
}

/** An expression of any value type, from field() and fn(). */
type AnyExpr<C extends Ctx = never> = NumExpr<C> & StrExpr<C> & BoolExpr<C>;
/** An expression producing T. */
type Expr<T extends number | string | boolean, C extends Ctx = never> =
  [T] extends [number] ? NumExpr<C> : [T] extends [string] ? StrExpr<C> : BoolExpr<C>;
/** A number or an expression producing one. */
type Num<C extends Ctx = never> = number | NumExpr<C>;
/** A MIDI note number (fractional allowed) or an expression producing one. */
type Pitch<C extends Ctx = never> = Num<C>;
/** true, false or an expression producing one. */
type Cond<C extends Ctx = never> = boolean | BoolExpr<C>;

/** A colour such as '#f6e05e'. */
type Hex = \`#\${string}\`;
/** A colour expression from color(hex). */
interface ColorExpr<C extends Ctx = never> {
  readonly __type?: 'color';
  readonly __ctx?: C;
  /** Blends toward other by t (0–1). */
  mix<D extends Ctx = never>(other: ColorLike<D>, t: Num<D>): ColorExpr<C | D>;
}
type ColorLike<C extends Ctx = never> = Hex | ColorExpr<C>;
/** Band levels from audio.spectrum(); for shader layers. */
interface SpectrumExpr {
  readonly __type: 'spectrum';
}

/** An LFO from lfo(). */
interface Lfo {
  readonly __lfo: true;
}

interface FollowOptions {
  /** Glide time in ms. Default 250. */
  smoothMs?: number;
}
interface ModOptions {
  /** Route strength, −1 to 1, as a fraction of the parameter's range. */
  depth: number;
  /** Smoothing of an expression source in ms. Default 250 (500 for orbit sources). */
  smoothMs?: number;
}
/** A parameter that accepts follow() only: choices take an option index. */
interface SetParam {
  /** Sets the parameter's base value from an expression. */
  follow(value: Num<GlobalCtx>, opts?: FollowOptions): void;
}
/** A numeric parameter. */
interface NumParam extends SetParam {
  /** Program output, inside handlers only: sets the base value. */
  set(value: number, opts?: { /** Default 250. */ smoothMs?: number }): void;
}
/** A modulatable parameter. */
interface ModParam extends NumParam {
  /** Adds a modulation route from an LFO or a −1..1 expression. */
  mod(source: Lfo | NumExpr<GlobalCtx>, opts: ModOptions): void;
}
/** A list parameter such as additive harmonics. */
interface ListParam {
  /** Program output, inside handlers only: sets the whole list at once, without smoothing. */
  set(values: readonly number[]): void;
}
interface BypassParam {
  /** Bypasses the effect while value is true. */
  follow(value: Cond<GlobalCtx>): void;
  /** Program output, inside handlers only. */
  set(on: boolean): void;
}
interface PlayOptions {
  /** 1–127. Default 100. */
  velocity?: number;
  /** −1 to 1. Default 0. */
  pan?: number;
  /** 20–10000 ms. Default 250. */
  durationMs?: number;
}
interface HoldOptions {
  /** 1–127. Default 100. */
  velocity?: number;
  /** −1 to 1. Default 0. */
  pan?: number;
}
/** Program output of an instrument, inside handlers only (doc/piece-dsl.md, Program). */
interface Playable {
  /** Plays one note. A null pitch plays nothing. */
  play(pitch: number | null, opts?: PlayOptions): void;
  /** Starts a sustained note named key; holding a sounding key restarts it. */
  hold(key: string, pitch: number | null, opts?: HoldOptions): void;
  /** Moves a held note to pitch over ms (default 150). */
  glide(key: string, pitch: number | null, ms?: number): void;
  /** Releases one held note. */
  stop(key: string): void;
  /** Releases every held note of this instrument. */
  stopAll(): void;
}

interface OrbitOptions {
  /** 1–1000; multiplies elapsed time. Default 1. */
  timeScale?: number;
}
/** sky.orbit(...): a VLFO that follow() can declare for read.orbit. */
type OrbitExpr = NumExpr & { readonly __orbit: true };
`;

/** @param {string} s */
const q = (s) => `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
/** @param {string[]} xs */
const union = (xs) => (xs.length ? xs.map(q).join(' | ') : 'never');
/** @param {string} s */
const key = (s) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? s : q(s));
/** @param {string} s */
const pascal = (s) => s.replace(/(^|[^A-Za-z0-9])([a-z0-9])/g, (_, __, c) => c.toUpperCase());
/** @param {number} x */
const fmt = (x) => String(x).replace('-', '−');

/** @param {ParamSpec} p */
function paramDoc(p) {
  if (p.kind === 'enum') return `${p.options?.map((o) => `'${o}'`).join(', ')}. Default '${p.default}'.`;
  if (p.kind === 'array') return `${p.length} values, each ${fmt(p.min)}–${fmt(p.max)}. Default [${/** @type {number[]} */ (p.default).join(', ')}]. Constructor, or set() in a handler.`;
  const label = unitLabel(p.unit);
  const unit = label ? ` ${label}` : '';
  const mod = !p.modulatable ? ' Set only.' : p.dir === 'down' ? ' Modulation lowers only.' : '';
  return `${fmt(p.min)}–${fmt(p.max)}${unit}. Default ${fmt(/** @type {number} */ (p.default))}.${mod}`;
}

/** @param {string} type @param {ParamSpec} p @param {string} name */
function optionType(type, p, name) {
  if (p.kind === 'enum') {
    // granular source 'sample' is the build error granular_sample: pieces cannot load files.
    const opts = type === 'granular' && name === 'source' ? (p.options ?? []).filter((o) => o !== 'sample') : p.options ?? [];
    return union(opts);
  }
  if (p.kind === 'array') return `[${Array.from({ length: /** @type {number} */ (p.length) }, () => 'number').join(', ')}]`;
  return 'number';
}

/** @param {ParamSpec} p */
const handleType = (p) => (p.kind === 'array' ? 'ListParam' : p.kind === 'number' ? (p.modulatable ? 'ModParam' : 'NumParam') : 'SetParam');

/**
 * @param {Defs} defs
 * @returns {string}
 */
export function generateBuilderDts(defs) {
  const L = [];
  L.push('// Generated by scripts/gen-builder-dts.mjs from PARAM_DEFS, the effect registry,');
  L.push('// src/visual/layer-defs.js and src/sky/groups.json. Do not edit.');
  L.push('// Global builder API of piece scripts (doc/piece-dsl.md, Types).');
  L.push('');
  L.push(CORE);

  L.push(`type Curve = ${union([...CURVES])};`);
  L.push(`type OrbitQuantity = ${union([...ORBIT_QUANTITIES])};`);
  L.push(`type LfoShape = ${union([...LFO_SHAPES])};`);
  L.push(`type SyncName = ${union(defs.syncNames)};`);
  L.push(`type ScaleMode = ${union([...SCALE_MODES])};`);
  L.push(`type NoteName = ${union(['C', 'D', 'E', 'F', 'G', 'A', 'B'].flatMap((n) => [n, `${n}#`, `${n}b`]))};`);
  L.push(`type Projection = ${union([...PROJECTIONS])};`);
  L.push(`type EventKind = ${union([...EVENT_KINDS])};`);
  L.push('');

  // ---- sky ----
  L.push('/** Field names and value types of each group, from src/sky/groups.json. */');
  L.push('interface GroupFields {');
  for (const [g, spec] of Object.entries(defs.groups)) {
    L.push(`  ${q(g)}: {`);
    for (const [f, fs] of Object.entries(spec.fields)) {
      if (fs.unit) L.push(`    /** ${fs.unit} */`);
      L.push(`    ${key(f)}: ${fs.type};`);
    }
    L.push('  };');
  }
  L.push('}');
  L.push('type GroupKey = keyof GroupFields;');
  L.push(`/** Groups whose objects have orbital elements. */`);
  L.push(`type OrbitGroupKey = ${union(Object.entries(defs.groups).filter(([, s]) => s.orbit).map(([g]) => g))};`);
  L.push(`/** Source registry ids. */`);
  L.push(`type SourceId = ${union(defs.sources)};`);
  const swpc = [];
  for (const [g, spec] of Object.entries(defs.groups)) {
    if (!g.startsWith('swpc.')) continue;
    for (const [f, fs] of Object.entries(spec.fields)) if (fs.type === 'number') swpc.push(`${g.slice(5)}.${f}`);
  }
  L.push(`type SwpcPath = ${union(swpc)};`);
  L.push(`type Fields<G extends GroupKey> = GroupFields[G];
type FieldName<G extends GroupKey> = keyof Fields<G> & string;
type NumericField<G extends GroupKey> = { [K in FieldName<G>]: Fields<G>[K] extends number ? K : never }[FieldName<G>];
type ObjectId<G extends string = GroupKey> = \`\${G}:\${string}\`;
type FieldExpr<T, C extends Ctx> = [T] extends [number] ? NumExpr<C> : [T] extends [string] ? StrExpr<C> : BoolExpr<C>;
/** The object proxy o passed to builder functions: o.<field> equals field('<field>'). */
type ObjectProxy<G extends GroupKey> = { readonly [K in FieldName<G>]: FieldExpr<Fields<G>[K], 'obj'> } &
  (G extends OrbitGroupKey ? { /** A VLFO from this object's orbit, −1 to 1. */ orbit(quantity: OrbitQuantity, opts?: OrbitOptions): NumExpr<'obj'> } : {});

interface VoiceOptions {
  pitch: Pitch<ObjectCtx>;
  /** 1–127. Default 64. */
  velocity?: Num<ObjectCtx>;
  /** −1 to 1. Default 0. */
  pan?: Num<ObjectCtx>;
  voiceMods?: Record<string, Num<ObjectCtx>>;
}
interface TriggerOptions {
  pitch: Pitch<ObjectCtx>;
  /** 1–127. Default 64. */
  velocity?: Num<ObjectCtx>;
  /** 20–10000 ms. Default 250. */
  durationMs?: number;
  /** 0.1–20. Default 2. */
  maxPerSecond?: number;
}
interface Group<G extends GroupKey> {
  readonly __group: G;
  /** The first n objects by field; order 'desc' (default) or 'asc'. */
  top(n: number, field: FieldName<G>, order?: 'asc' | 'desc'): Group<G>;
  /** One sustained voice per object. */
  voices(inst: Instrument, opts: VoiceOptions | ((o: ObjectProxy<G>) => VoiceOptions)): void;
  on(kind: EventKind): GroupEvent<G>;
  /** Number of live objects. */
  count(): NumExpr;
  /** Mean of a numeric field. */
  mean(field: NumericField<G>): NumExpr;
  /** Maximum minus minimum of a numeric field. */
  spread(field: NumericField<G>): NumExpr;
}
interface GroupEvent<G extends GroupKey> {
  when(cond: Cond<ObjectCtx> | ((o: ObjectProxy<G>) => Cond<ObjectCtx>)): GroupEvent<G>;
  /** One note per event. */
  trigger(inst: Instrument, opts: TriggerOptions | ((o: ObjectProxy<G>) => TriggerOptions)): void;
}
interface Sky {
  group<G extends GroupKey>(key: G): Group<G>;
  /** A space-weather value. */
  swpc(path: SwpcPath): NumExpr;
  /** One field of one object. */
  value<G extends GroupKey, K extends FieldName<G>>(objectId: ObjectId<G>, field: K): FieldExpr<Fields<G>[K], never>;
  /** A VLFO from one named object's orbit, −1 to 1. */
  orbit(objectId: ObjectId<OrbitGroupKey>, quantity: OrbitQuantity, opts?: OrbitOptions): OrbitExpr;
}
`);

  // ---- instruments ----
  const instTypes = Object.keys(defs.instruments);
  const effTypes = Object.keys(defs.effects);
  const tune = defs.tuning;
  for (const type of instTypes) {
    const spec = defs.instruments[type];
    const P = pascal(type);
    L.push(`interface ${P}Options {`);
    L.push(`  /** Volume in dB, ${fmt(tune.volume.min)}–${fmt(tune.volume.max)}. Default ${fmt(tune.volume.default)}. */`);
    L.push('  volume?: number;');
    L.push(`  /** ${fmt(tune.octave.min)}–${fmt(tune.octave.max)}. Default ${fmt(tune.octave.default)}. */`);
    L.push('  octave?: number;');
    L.push(`  /** ${fmt(tune.cents.min)}–${fmt(tune.cents.max)}. Default ${fmt(tune.cents.default)}. */`);
    L.push('  cents?: number;');
    for (const name of spec.order) {
      const p = spec.params[name];
      L.push(`  /** ${paramDoc(p)} */`);
      L.push(`  ${key(name)}?: ${optionType(type, p, name)};`);
    }
    L.push('}');
    L.push(`interface ${P}Handle extends Playable {`);
    L.push(`  readonly __instrument: ${q(type)};`);
    L.push('  /** Sets the insert chain, in order; calling it again replaces the chain. */');
    L.push('  fx(...slots: Effect[]): void;');
    for (const name of spec.order) {
      const h = handleType(spec.params[name]);
      if (!h) continue;
      L.push(`  /** ${paramDoc(spec.params[name])} */`);
      L.push(`  readonly ${key(name)}: ${h};`);
    }
    L.push('}');
  }
  L.push(`type Instrument = ${instTypes.map((t) => `${pascal(t)}Handle`).join(' | ') || 'never'};`);
  L.push(`type InstrumentType = ${union(instTypes)};`);
  L.push('');

  // ---- effects ----
  for (const type of effTypes) {
    const spec = defs.effects[type];
    const P = pascal(type);
    L.push(`interface ${P}Options {`);
    for (const name of spec.order) {
      const p = spec.params[name];
      L.push(`  /** ${paramDoc(p)} */`);
      L.push(`  ${key(name)}?: ${optionType(type, p, name)};`);
    }
    L.push('  /** Default false. */');
    L.push('  bypass?: boolean;');
    L.push('}');
    L.push(`interface ${P}Handle {`);
    L.push(`  readonly __effect: ${q(type)};`);
    L.push('  readonly bypass: BypassParam;');
    for (const name of spec.order) {
      const h = handleType(spec.params[name]);
      if (!h) continue;
      L.push(`  /** ${paramDoc(spec.params[name])} */`);
      L.push(`  readonly ${key(name)}: ${h};`);
    }
    L.push('}');
  }
  L.push(`type Effect = ${effTypes.map((t) => `${pascal(t)}Handle`).join(' | ') || 'never'};`);
  L.push(`type EffectType = ${union(effTypes)};`);
  L.push('');
  L.push('interface InstrumentOptionsMap {');
  for (const t of instTypes) L.push(`  ${key(t)}: ${pascal(t)}Options;`);
  L.push('}');
  L.push('interface EffectOptionsMap {');
  for (const t of effTypes) L.push(`  ${key(t)}: ${pascal(t)}Options;`);
  L.push('}');
  L.push('interface InstrumentHandleMap {');
  for (const t of instTypes) L.push(`  ${key(t)}: ${pascal(t)}Handle;`);
  L.push('}');
  L.push('interface EffectHandleMap {');
  for (const t of effTypes) L.push(`  ${key(t)}: ${pascal(t)}Handle;`);
  L.push('}');
  L.push(`/** Option object of an instrument or effect type. */
type ParamsOf<T extends InstrumentType | EffectType> =
  T extends InstrumentType ? InstrumentOptionsMap[T] : T extends EffectType ? EffectOptionsMap[T] : never;
/** Handle of an instrument or effect type. */
type Handle<T extends InstrumentType | EffectType> =
  T extends InstrumentType ? InstrumentHandleMap[T] : T extends EffectType ? EffectHandleMap[T] : never;

interface LfoOptions {
  /** Default 'sine'. */
  shape?: LfoShape;
  /** 0.01–20 Hz, a sync value such as '1/4d', or an expression ending in .map(...) or .clamp(...). Default 0.1. */
  rate?: number | SyncName | NumExpr<GlobalCtx>;
  /** Starting point in the cycle, 0–1. Default 0. */
  phase?: number;
  /** Restart per note (instrument targets only). Default false. */
  retrigger?: boolean;
  /** 0–1. Default 0.5 for 'smooth', 0 otherwise. */
  smooth?: number;
}
interface ReactionActions {
  /** Detunes every instrument, −100 to 100 cents. */
  detuneCents?: number;
  mute?: Instrument[];
  only?: Instrument[];
  /** Removes colour from the picture, 0–1. */
  desaturate?: number;
}
`);

  // ---- layers ----
  const layerTypes = Object.keys(defs.layers);
  for (const type of layerTypes) {
    const spec = defs.layers[type];
    L.push(`interface ${pascal(type)}LayerProps<C extends Ctx> {`);
    for (const name of spec.order) {
      const p = spec.props[name];
      const doc = p.type === 'number' ? `${fmt(/** @type {number} */ (p.min))}–${fmt(/** @type {number} */ (p.max))}${p.unit ? ` ${p.unit}` : ''}. Default ${fmt(/** @type {number} */ (p.default))}.`
        : p.type === 'enum' ? `${p.options?.map((o) => `'${o}'`).join(', ')}. Default '${p.default}'.`
          : `Default '${p.default}'.`;
      const t = p.type === 'number' ? 'Num<C>' : p.type === 'color' ? 'ColorLike<C>' : p.type === 'enum' ? `${union(p.options ?? [])} | StrExpr<C>` : 'string | StrExpr<C>';
      L.push(`  /** ${doc} */`);
      L.push(`  ${key(name)}?: ${t};`);
    }
    L.push('}');
    L.push(`/** Constant values of a ${type} layer, for set() in handlers. */`);
    L.push(`interface ${pascal(type)}LayerValues {`);
    for (const name of spec.order) {
      const p = spec.props[name];
      const t = p.type === 'number' ? 'number' : p.type === 'color' ? 'Hex' : p.type === 'enum' ? union(p.options ?? []) : 'string';
      L.push(`  ${key(name)}?: ${t};`);
    }
    L.push('}');
    L.push(`interface ${pascal(type)}Layer {`);
    L.push('  /** Program output, inside handlers only: sets constant property values. */');
    L.push(`  set(props: ${pascal(type)}LayerValues): void;`);
    L.push('}');
  }
  L.push('interface Layers {');
  for (const type of layerTypes) {
    const P = `${pascal(type)}LayerProps`;
    if (defs.layers[type].group) {
      L.push(`  ${key(type)}<G extends GroupKey>(group: Group<G>, props: ${P}<LayerCtx> | ((o: ObjectProxy<G>) => ${P}<LayerCtx>)): ${pascal(type)}Layer;`);
    } else {
      L.push(`  ${key(type)}(props: ${P}<ScreenCtx>): ${pascal(type)}Layer;`);
    }
  }
  L.push('  /** A fragment-shader layer. The piece becomes local-only. */');
  L.push('  shader(glsl: string, props?: Record<string, Num<ScreenCtx> | SpectrumExpr>): void;');
  L.push('}');
  L.push(`interface View {
  projection(p: Projection): void;
  background(color: ColorLike<ScreenCtx>): void;
}
interface AudioSignals {
  /** RMS level of the instrument output, 0–1. Layer properties only. */
  level(inst: Instrument): NumExpr<'audio'>;
  /** bands (4–32) band levels, 0–1. Shader layers only. */
  spectrum(inst: Instrument, bands: number): SpectrumExpr;
  voice(inst: Instrument): {
    /** Envelope of the voice bound to the current object, 0–1. Layer properties only. */
    env(): NumExpr<'audio' | 'obj'>;
  };
}

/** Sets the scale used by .quantize(). Default 'C', 'chromatic'. */
declare function scale(root: NoteName, mode: ScaleMode): void;
/** Sets the piece seed (integer). Default 1. */
declare function seed(n: number): void;
/** Sets the tempo for synced delays and LFOs, 20–300. Default 120. */
declare function tempo(bpm: number): void;
/** A field of the current object; null when absent. */
declare function field(name: string): AnyExpr<'obj'>;
/** A constant. */
declare function num(x: number): NumExpr;
/** A deterministic number in [lo, hi), fixed per object. */
declare function rand(lo: number, hi: number): NumExpr;
/** A VLFO from the current object's orbit, −1 to 1. Voice, trigger and layer options only. */
declare function orbit(quantity: OrbitQuantity, opts?: OrbitOptions): NumExpr<'obj'>;
/** An LFO for mod(). */
declare function lfo(opts?: LfoOptions): Lfo;
/** Applies actions while source is stale. */
declare function onStale(source: SourceId | GroupKey | '*', actions: ReactionActions): void;
/** Applies actions while source is down. */
declare function onDown(source: SourceId | GroupKey | '*', actions: ReactionActions): void;
/** A colour expression. */
declare function color(hex: Hex): ColorExpr;
/** An expression computed by a JavaScript function given as text. The piece becomes local-only. */
declare function fn(source: string): AnyExpr<'fn'>;
declare const master: {
  /** Sets the master chain, in order. */
  fx(...slots: Effect[]): void;
};
/** A sky object as a program sees it: its id, its group and its current field values. */
type SkyRecord<G extends GroupKey> = { readonly id: ObjectId<G>; readonly group: G } & { readonly [K in FieldName<G>]: Fields<G>[K] | null };
interface SkyChange<G extends GroupKey> {
  readonly kind: 'enter' | 'update' | 'exit';
  readonly traceId: string | null;
  /** True for objects already in the group when the program starts. */
  readonly initial: boolean;
  /** The record before an update or exit, otherwise null. */
  readonly prev: SkyRecord<G> | null;
}
type FreshState = 'loading' | 'fresh' | 'stale' | 'down';
/** Live reads, inside handlers only. */
interface Read {
  swpc(path: SwpcPath): number | null;
  group<G extends GroupKey>(key: G): readonly SkyRecord<G>[];
  object<G extends GroupKey>(id: ObjectId<G>): SkyRecord<G> | null;
  freshness(source: SourceId | GroupKey): FreshState;
  /** An orbit declared with follow(sky.orbit(...)), −1 to 1, or null before the first sample. */
  orbit(objectId: ObjectId<OrbitGroupKey>, quantity: OrbitQuantity, opts?: OrbitOptions): number | null;
}
/** Calls fn for each event of kind in group while the piece plays. Setup only. */
declare function on<G extends GroupKey>(group: G, kind: EventKind | '*', fn: (o: SkyRecord<G>, e: SkyChange<G>) => void): void;
/** Calls fn every interval: 10–3600000 ms, or a sync value at the piece tempo. Setup only. */
declare function every(interval: number | SyncName, fn: (t: number) => void): void;
/** Calls fn once, ms (0–3600000) from now. Returns a function that cancels the call. */
declare function after(ms: number, fn: (t: number) => void): () => void;
/** Calls fn when the freshness of source changes. Setup only. */
declare function onFreshness(source: SourceId | GroupKey | '*', fn: (f: { readonly source: string; readonly state: FreshState }) => void): void;
/** Follows groups that the script reads with read.* but names nowhere else, and declares sky.orbit(...) VLFOs for read.orbit. Setup only. */
declare function follow(...groups: (GroupKey | OrbitExpr)[]): void;
declare const read: Read;
/** Milliseconds since the program started. */
declare function time(): number;
/** A number in [0, 1), seeded by seed(). */
declare function random(): number;
/** An integer in [0, n), seeded by seed(). */
declare function randInt(n: number): number;
/** One element of list, seeded by seed(). */
declare function choose<T>(list: readonly T[]): T;
declare const sky: Sky;
declare const view: View;
declare const layer: Layers;
declare const audio: AudioSignals;`);
  for (const type of instTypes) L.push(`declare function ${type}(opts?: ${pascal(type)}Options): ${pascal(type)}Handle;`);
  for (const type of effTypes) L.push(`declare function ${type}(opts?: ${pascal(type)}Options): ${pascal(type)}Handle;`);
  L.push('');
  return L.join('\n');
}
