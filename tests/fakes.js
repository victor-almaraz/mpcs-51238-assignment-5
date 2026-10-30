// Test fakes for the binding runtime and audio host (doc/bindings.md, Fakes).
// No AudioContext, no network. Every fake records its calls as [method, ...args].

/** Thrown by FakeInstrument when more than its cap of voices sound at once. */
export class CapExceeded extends Error {
  constructor(message) { super(message); this.name = 'CapExceeded'; }
}
/** doc/audio/effects.md, Limits. */
export class FxLimitError extends Error {
  constructor(limit) { super(`Effect limit exceeded: ${limit}`); this.name = 'FxLimitError'; this.limit = limit; }
}
/** doc/audio/modulation.md, Limits. */
export class ModLimitError extends Error {
  constructor(limit) { super(`Modulation limit exceeded: ${limit}`); this.name = 'ModLimitError'; this.limit = limit; }
}
/** doc/audio/modulation.md, Engine API. */
export class ModTargetError extends Error {
  constructor(target) { super(`Invalid modulation target: ${target}`); this.name = 'ModTargetError'; this.target = target; }
}

/**
 * Fake Instrument with optional VoiceControl.
 * Options: `cap` (default 16, 4 for granular), `steal` (steal the oldest voice instead of
 * throwing), `voiceControl` (true, false, or a list of method names to implement),
 * `ranges` ({ name: [min, max] }, clamps setParam like coerceParam).
 */
export class FakeInstrument {
  constructor(type = 'subtractive', opts = {}) {
    this.type = type;
    this.cap = opts.cap ?? (type === 'granular' ? 4 : 16);
    this.steal = !!opts.steal;
    this.ranges = opts.ranges ?? {};
    this.params = { ...(opts.params ?? {}) };
    /** @type {any[][]} */
    this.calls = [];
    /** @type {{ pitch: number, source: string, start: number, end: number | null }[]} */
    this.voices = [];
    this.stolen = 0;
    const vc = opts.voiceControl ?? true;
    const has = (m) => vc === true || (Array.isArray(vc) && vc.includes(m));
    if (has('setVoicePitch')) this.setVoicePitch = (source, pitch, glideMs) => { this.calls.push(['setVoicePitch', source, pitch, glideMs]); };
    if (has('setVoicePan')) this.setVoicePan = (source, pan) => { this.calls.push(['setVoicePan', source, pan]); };
    if (has('setVoiceMod')) this.setVoiceMod = (source, mods) => { this.calls.push(['setVoiceMod', source, { ...mods }]); };
  }

  /** Voices sounding at time `t`: started at or before `t`, not yet released at `t`. */
  soundingAt(t) {
    return this.voices.filter((v) => v.start <= t && (v.end === null || v.end > t));
  }

  /** Held voices at `t`: started at or before `t` with no release scheduled. */
  heldAt(t) {
    return this.voices.filter((v) => v.start <= t && v.end === null);
  }

  /**
   * Voices in release take a slot until their release time, and the engine steals them first
   * (doc/audio/audio-engine-core.md, stealing order). The fake throws only when more than `cap`
   * voices are held, the condition the binding runtime must never cause on its own.
   */
  noteOn(pitch, velocity, time, source) {
    this.calls.push(['noteOn', pitch, velocity, time, source]);
    const sounding = this.soundingAt(time);
    if (sounding.length >= this.cap) {
      const releasing = sounding.filter((v) => v.end !== null).sort((a, b) => a.start - b.start);
      if (releasing.length) {
        releasing[0].end = time;
      } else {
        if (!this.steal) throw new CapExceeded(`${this.type}: more than ${this.cap} held voices at t=${time}`);
        sounding.sort((a, b) => a.start - b.start)[0].end = time;
        this.stolen++;
      }
    }
    this.voices.push({ pitch, source, start: time, end: null });
  }

  /** Releases the oldest voice with this pitch and source that started before `time`. */
  noteOff(pitch, time, source) {
    this.calls.push(['noteOff', pitch, time, source]);
    const v = this.voices.find((x) => x.pitch === pitch && x.source === source && x.start < time && x.end === null);
    if (v) v.end = time;
  }

  allNotesOff(time) {
    this.calls.push(['allNotesOff', time]);
    for (const v of this.voices) if (v.end === null || v.end > time) v.end = time;
  }

  setParam(name, value) {
    this.calls.push(['setParam', name, value]);
    const r = this.ranges[name];
    this.params[name] = r && typeof value === 'number' ? Math.min(Math.max(value, r[0]), r[1]) : value;
  }

  getParams() { return { ...this.params }; }

  dispose() { this.calls.push(['dispose']); }

  /** Calls of one method. */
  callsOf(method) { return this.calls.filter((c) => c[0] === method); }
}

const FX_SLOTS_PER_CHAIN = 8;
const FX_REVERBS = 4;
const MOD_LFOS = 16;
const MOD_ROUTES = 32;
const MOD_ROUTES_PER_TARGET = 4;

/**
 * Fake engine: `sync`, `get`, `pump`, EngineFx and EngineMod. Records every call in `calls`.
 * Options: `instrument(widget)` returns the FakeInstrument for a new widget; `targets` is a
 * set of valid modulation targets (default: any `<instrument or slot id>.<name>`).
 */
export class FakeEngine {
  constructor(opts = {}) {
    this.makeInstrument = opts.instrument ?? ((w) => new FakeInstrument(w.type, { params: w.params }));
    this.targets = opts.targets ?? null;
    /** @type {any[][]} */
    this.calls = [];
    /** @type {Map<string, FakeInstrument>} */
    this.instruments = new Map();
    this.widgets = [];
    /** @type {Map<string, any[]>} */
    this.chains = new Map();
    this.lfos = [];
    this.routes = [];
    this.modValues = new Map();
    this.tempo = 120;
    this.faultHandlers = [];
    this.opts = opts.engineOptions ?? null;
  }

  sync(widgets) {
    this.calls.push(['sync', structuredClone(widgets)]);
    const ids = new Set(widgets.map((w) => w.id));
    for (const [id, inst] of this.instruments) {
      if (!ids.has(id)) { inst.allNotesOff(0); inst.dispose(); this.instruments.delete(id); }
    }
    for (const w of widgets) {
      let inst = this.instruments.get(w.id);
      if (!inst || inst.type !== w.type) {
        inst = this.makeInstrument(w);
        this.instruments.set(w.id, inst);
      } else {
        for (const [k, v] of Object.entries(w.params ?? {})) if (inst.params[k] !== v) inst.setParam(k, v);
      }
    }
    this.widgets = structuredClone(widgets);
  }

  get(id) { return this.instruments.get(id) ?? null; }

  pump(until) { this.calls.push(['pump', until]); }

  setTempo(bpm) {
    this.calls.push(['setTempo', bpm]);
    if (!(bpm >= 20 && bpm <= 300)) throw new FxLimitError('tempo');
    this.tempo = bpm;
  }

  setFx(owner, slots) {
    this.calls.push(['setFx', owner, structuredClone(slots)]);
    if (slots.length > FX_SLOTS_PER_CHAIN) throw new FxLimitError('slots');
    const next = new Map(this.chains);
    if (slots.length === 0) next.delete(owner); else next.set(owner, structuredClone(slots));
    const all = [...next.values()].flat();
    if (all.filter((s) => s.type === 'reverb').length > FX_REVERBS) throw new FxLimitError('reverbs');
    const ids = all.map((s) => s.id);
    if (new Set(ids).size !== ids.length) throw new FxLimitError('slot ids');
    this.chains = next;
  }

  findSlot(slotId) {
    for (const slots of this.chains.values()) for (const s of slots) if (s.id === slotId) return s;
    return null;
  }

  setFxParam(slotId, name, value) {
    this.calls.push(['setFxParam', slotId, name, value]);
    const s = this.findSlot(slotId);
    if (!s) throw new Error(`Unknown slot ${slotId}`);
    s.params[name] = value;
  }

  setFxBypass(slotId, on) {
    this.calls.push(['setFxBypass', slotId, on]);
    const s = this.findSlot(slotId);
    if (!s) throw new Error(`Unknown slot ${slotId}`);
    s.bypass = on;
  }

  onFxFault(fn) { this.calls.push(['onFxFault']); this.faultHandlers.push(fn); }

  /** Test helper: reports a slot fault to the registered handlers. */
  fault(owner, slotId) { for (const fn of this.faultHandlers) fn(owner, slotId); }

  setLfos(lfos) {
    this.calls.push(['setLfos', structuredClone(lfos)]);
    if (lfos.length > MOD_LFOS) throw new ModLimitError('lfos');
    for (const l of lfos) {
      if (typeof l.rate === 'number' && !(l.rate >= 0.01 && l.rate <= 20)) throw new ModLimitError('rate');
    }
    this.lfos = structuredClone(lfos);
  }

  validTarget(target) {
    if (this.targets) return this.targets.has(target);
    const [owner] = target.split('.');
    return this.instruments.has(owner) || this.findSlot(owner) !== null;
  }

  setMods(routes) {
    this.calls.push(['setMods', structuredClone(routes)]);
    if (routes.length > MOD_ROUTES) throw new ModLimitError('routes');
    const perTarget = new Map();
    for (const r of routes) {
      if (!this.validTarget(r.target)) throw new ModTargetError(r.target);
      if (!(r.depth >= -1 && r.depth <= 1)) throw new ModLimitError('depth');
      perTarget.set(r.target, (perTarget.get(r.target) ?? 0) + 1);
      if (perTarget.get(r.target) > MOD_ROUTES_PER_TARGET) throw new ModLimitError('routes_per_target');
    }
    this.routes = structuredClone(routes);
  }

  postModValue(sourceId, value, smoothMs) {
    this.calls.push(['postModValue', sourceId, value, smoothMs]);
    if (Number.isFinite(value)) this.modValues.set(sourceId, Math.min(Math.max(value, -1), 1));
  }

  modulatedValue() { return null; }

  callsOf(method) { return this.calls.filter((c) => c[0] === method); }
}

/** Fake AudioParam: records automation calls, holds `value`. */
export class FakeAudioParam {
  constructor(value = 0, { minValue = -3.4028234663852886e38, maxValue = 3.4028234663852886e38 } = {}) {
    this.value = value;
    this.defaultValue = value;
    this.minValue = minValue;
    this.maxValue = maxValue;
    this.events = [];
  }
  setValueAtTime(v, t) { this.events.push(['setValueAtTime', v, t]); this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this.events.push(['linearRampToValueAtTime', v, t]); this.value = v; return this; }
  exponentialRampToValueAtTime(v, t) {
    if (v === 0) throw new RangeError('exponentialRampToValueAtTime target 0');
    this.events.push(['exponentialRampToValueAtTime', v, t]); this.value = v; return this;
  }
  setTargetAtTime(v, t, tau) { this.events.push(['setTargetAtTime', v, t, tau]); this.value = v; return this; }
  setValueCurveAtTime(curve, t, d) { this.events.push(['setValueCurveAtTime', [...curve], t, d]); return this; }
  cancelScheduledValues(t) { this.events.push(['cancelScheduledValues', t]); return this; }
  cancelAndHoldAtTime(t) { this.events.push(['cancelAndHoldAtTime', t]); return this; }
}

/**
 * Manual clock: wall time `now()` in ms, `audioTime()` in s, timers that fire on `advance`.
 * @param {{ start?: number, epoch?: number, audioOffset?: number }} [opts]
 */
export function createFakeClock({ start = 0, epoch = Date.UTC(2026, 9, 29, 14, 0, 0), audioOffset = 0 } = {}) {
  let t = start;
  let nextId = 1;
  /** @type {Map<number, { at: number, every: number | null, fn: () => void }>} */
  const timers = new Map();
  const clock = {
    now: () => t,
    wallNow: () => epoch + t,
    audioTime: () => t / 1000 + audioOffset,
    setInterval(fn, ms) { const id = nextId++; timers.set(id, { at: t + ms, every: Math.max(1, ms), fn }); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(fn, ms) { const id = nextId++; timers.set(id, { at: t + ms, every: null, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    /** Advances time by `ms`, firing due timers in time order. */
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let id = null, due = null;
        for (const [k, v] of timers) if (v.at <= end && (due === null || v.at < due.at)) { id = k; due = v; }
        if (!due) break;
        t = due.at;
        if (due.every === null) timers.delete(id); else due.at += due.every;
        due.fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
  return clock;
}

/**
 * Fake sky store implementing the Sky interface (doc/sky-contract.md) with emit helpers.
 */
export function createFakeSky() {
  /** @type {Map<string, Map<string, any>>} */
  const groups = new Map();
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();
  /** @type {Map<string, any>} */
  const fresh = new Map();
  let traceN = 0;
  const emit = (e) => { for (const fn of [...(handlers.get(e.type) ?? [])]) fn(e); };
  const groupMap = (g) => { if (!groups.has(g)) groups.set(g, new Map()); return groups.get(g); };
  const sky = {
    mode: 'live',
    followed: [],
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);
    },
    get(group) {
      return [...groupMap(group).values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    freshness(source) {
      return fresh.get(source) ?? { source, state: 'loading', lastRun: null, lastSuccess: null };
    },
    async follow(gs) { sky.followed = [...gs]; },
    listenerCount: (type) => handlers.get(type)?.size ?? 0,

    /** Adds or replaces an object without emitting (initial snapshot). */
    put(obj) { groupMap(obj.group).set(obj.id, structuredClone(obj)); },
    enter(obj, traceId = `t${++traceN}`, extra = {}) {
      const o = structuredClone(obj);
      groupMap(o.group).set(o.id, o);
      emit({ type: 'enter', obj: o, prev: null, traceId, ...extra });
    },
    update(id, fields, traceId = `t${++traceN}`) {
      const g = id.slice(0, id.indexOf(':'));
      const prev = groupMap(g).get(id);
      if (!prev) throw new Error(`update of unknown object ${id}`);
      const o = { ...prev, fields: { ...prev.fields, ...fields } };
      groupMap(g).set(id, o);
      emit({ type: 'update', obj: o, prev, traceId });
    },
    exit(id, traceId = `t${++traceN}`) {
      const g = id.slice(0, id.indexOf(':'));
      const prev = groupMap(g).get(id);
      if (!prev) throw new Error(`exit of unknown object ${id}`);
      groupMap(g).delete(id);
      emit({ type: 'exit', obj: prev, prev, traceId });
    },
    setFreshness(source, state) {
      const f = { source, state, lastRun: null, lastSuccess: null };
      fresh.set(source, f);
      emit({ type: 'freshness', freshness: f });
    },
  };
  return sky;
}

/** Collects trace records. */
export function createTraceSink() {
  const records = [];
  const trace = (r) => { records.push(r); };
  trace.records = records;
  trace.of = (pred) => records.filter((r) => Object.entries(pred).every(([k, v]) => r[k] === v));
  return trace;
}

/** Helper: an object in `group` with key `key`. */
export function skyObj(group, key, fields) {
  return { id: `${group}:${key}`, source: group, group, fields };
}
