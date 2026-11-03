// One playing piece in a tab: sky store (live or replay behind a switch), orbit propagator,
// audio host, master controls, renderer and sandbox. Browser-only; import it dynamically from a
// client component's effect so nothing here runs during prerendering.
//
// Run order (doc/bindings.md, Audio host): `run()` must be called synchronously inside the click
// handler, so `ensureRunning()` keeps the user activation. `load(ir)` follows the IR's groups,
// updates the preview and hot-reloads a playing piece; it never starts audio.

import { createSky, createReplay, createSynthetic, sourceOf } from '../sky/index.js';
import { trace as busTrace, setCapacity } from '../trace/bus.js';
import { createAudioHost } from '../audio-host/index.js';
import { createMasterControls } from '../audio-host/master.js';
import { createPropagator } from '../visual/propagator.js';
import { mountVisuals } from '../visual/mount.js';
import { pixelRatioFor } from '../visual/motion.js';
import { audioNow } from '../visual/av-sync.js';
import { createSandbox } from '../dsl/run-sandbox.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';
import { createSkySwitch, createNullSky } from './sky-switch.js';
import { createLocalFn } from './local-fn.js';
import { audioDrivenProps, backgroundValue, computeLayerValues, orbitGroupsOf, orbitSourcesOf } from './ir-helpers.js';
import { canonicalJson } from '../bind/canonical.js';

export const LAYER_VALUES_MS = 250;
/** Most device pixels the editor preview draws (doc/visuals.md, Renderer). */
export const PREVIEW_MAX_PIXELS = 1_500_000;
/** Most frames the renderer draws per second, so the main thread keeps time for audio (doc/visuals.md, Renderer). */
export const MAX_FPS = 30;

/**
 * @typedef {'stopped' | 'starting' | 'playing' | 'muted' | 'fault'} AudioState
 * @typedef {{ id: number, kind: string, live: 'polite' | 'assertive', message: string }} Notice
 * @typedef {{
 *   ready: boolean, audio: AudioState, mode: 'live' | 'replay' | 'synthetic',
 *   replay: { speed: number, from: number, to: number, ended: boolean } | null,
 *   notices: Notice[], error: string | null, followed: string[], playingIr: any | null,
 *   visualsAvailable: boolean | null,
 *   runtimeProblems: { severity: 'error', code: string, path: string, line: number | null, message: string }[],
 * }} SessionState
 */

/**
 * @param {{
 *   client: any | null,
 *   kiosk?: boolean,
 *   settings?: any,
 *   trace?: (r: any) => any,
 *   engineModule?: any,
 *   createWorker?: () => any,
 * }} opts `createWorker` replaces the SGP4 Web Worker (tests)
 */
export function createPieceSession({ client, kiosk = false, settings = DEFAULT_SETTINGS, trace: sinkTrace = busTrace, engineModule = null, createWorker }) {
  // The binding runtime and the host emit records without a cause (run, reload, reactions) with
  // `traceId: null`; the bus requires a non-empty id, so each such record gets its own. A record
  // the bus rejects is logged and never breaks playback.
  const trace = (/** @type {any} */ r) => {
    try {
      return sinkTrace(r && !r.traceId ? { ...r, traceId: `${String(r.stage ?? 'trace').toLowerCase()}-${globalThis.crypto.randomUUID()}` } : r);
    } catch (err) {
      console.error('trace record rejected', err, r);
      return null;
    }
  };
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {SessionState} */
  let state = {
    ready: false, audio: 'stopped', mode: 'live', replay: null, notices: [], error: null, followed: [], playingIr: null,
    visualsAvailable: null, runtimeProblems: [],
  };
  /** Problems from the running program, shown next to build problems (doc/ui.md, Editor). */
  const MAX_RUNTIME_PROBLEMS = 50;
  let noticeId = 0;
  let cfg = settings;
  /** Sorted groups of the last follow, and canonical JSON of the last IR the visuals were given. */
  let followedKey = null;
  let loadedKey = null;
  /** One layer-value push per batch of program commands. */
  let pushQueued = false;
  const queuePush = () => {
    if (pushQueued) return;
    pushQueued = true;
    queueMicrotask(() => { pushQueued = false; pushValues(); });
  };
  /** @type {any} */ let ir = null;
  /** @type {any} */ let renderer = null;
  /** @type {any} */ let host = null;
  /** @type {ReturnType<typeof createMasterControls> | null} */ let master = null;
  let valuesTimer = null;
  let disposed = false;
  /** Advanced by Stop, Panic, Restart Audio and dispose; a Run whose token is stale is undone. */
  let runToken = 0;
  let sandbox = null;

  const set = (/** @type {Partial<SessionState>} */ patch) => {
    state = { ...state, ...patch };
    for (const fn of [...listeners]) fn();
  };

  const makeLive = () => {
    if (!client) return createNullSky();
    try {
      return createSky({ client, trace, doc: kiosk ? null : globalThis.document ?? null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return createNullSky();
    }
  };

  let live = makeLive();
  const sky = createSkySwitch(live, {
    onError: (err, e) => trace({
      traceId: 'traceId' in e ? e.traceId : 'sky', stage: 'REALTIME', component: 'sky', event: 'listener_error', level: 'error',
      data: { type: e.type, message: err instanceof Error ? err.message : String(err) },
    }),
  });

  const propagator = createPropagator(createWorker ? { trace, createWorker } : { trace });
  propagator.follow(sky);
  propagator.setObserver(cfg.data.observer);

  const getSandbox = () => (sandbox ??= createSandbox());
  const local = createLocalFn({ evalFn: (source, arg) => getSandbox().evalFn(source, arg) });

  /** @param {any} n */
  const notify = (n) => {
    const notice = { id: ++noticeId, kind: n.kind, live: n.live, message: n.message };
    set({ notices: [...state.notices.filter((x) => x.kind !== n.kind || n.kind === 'fxFault'), notice] });
    if (n.kind === 'fault' || n.kind === 'engineFault' || n.kind === 'safetyError') set({ audio: 'fault' });
  };

  function makeHost(mod) {
    host = createAudioHost({
      engineModule: mod,
      sky,
      trace,
      notify,
      orbit: (objectId, quantity, timeScale) => propagator.orbitValue(objectId, quantity, timeScale),
      local,
      vm: { program: (msg) => getSandbox().program(msg) },
      onProgramProblem: (p) => set({
        runtimeProblems: [...state.runtimeProblems, { severity: 'error', code: p.code, path: '/program', line: p.line, message: p.message }].slice(-MAX_RUNTIME_PROBLEMS),
      }),
      onLayerValues: queuePush,
      groupSource: (g) => sourceOf(g) ?? g,
      onVisualReaction: (d) => renderer?.setDesaturate(d),
      masterLevel: () => (master ? master.level() : null),
      ownerLabel: (owner, pieceIr) => {
        if (owner === 'master') return 'master';
        const i = (pieceIr?.instruments ?? []).find((x) => x.id === owner);
        return i ? `${i.type} ${owner}` : owner;
      },
    });
    master = createMasterControls(host);
    master.setLevel(cfg.audio.masterDb, cfg.audio.maxMasterDb);
    propagator.onSample(() => host?.orbitTick());
    set({ ready: true });
  }

  const engineReady = (engineModule ? Promise.resolve(engineModule) : import('../audio-host/engine-imports.js'))
    .then((mod) => { if (!disposed) makeHost(mod); })
    .catch((err) => set({ error: `The audio engine failed to load: ${err instanceof Error ? err.message : String(err)}` }));

  function pushValues() {
    const rt = host?.runtime;
    if (!renderer || !ir || !rt) return;
    const props = (/** @type {any} */ layer, /** @type {any} */ obj) => rt.layerProps(layer, obj);
    try {
      const values = computeLayerValues(ir, sky, props);
      for (const [id, v] of Object.entries(host?.program?.layerValues() ?? {})) values[id] = { ...values[id], ...v };
      renderer.setLayerValues(values);
      const bg = backgroundValue(ir, props);
      if (bg) renderer.setBackground(bg);
    } catch (err) {
      trace({ traceId: 'layer-values', stage: 'VISUAL', component: 'renderer', event: 'valuesError', level: 'error', data: { message: err instanceof Error ? err.message : String(err) } });
    }
  }

  let hasAudioProps = false;
  function applyIrToVisuals() {
    if (!ir) return;
    hasAudioProps = (ir.layers ?? []).some((/** @type {any} */ l) => audioDrivenProps(l).length > 0);
    if (!renderer) return;
    renderer.setView(ir.view);
    renderer.setLayers(ir.layers);
    renderer.setGroups(ir.groups);
  }

  const session = {
    sky,
    propagator,
    get host() { return host; },
    get master() { return master; },
    get ir() { return ir; },
    get sandbox() { return getSandbox(); },
    ready: engineReady,

    /** @param {() => void} fn */
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    getState() { return state; },

    /**
     * Uses a validated IR: follows its groups, updates the preview and hot-reloads a playing piece.
     * @param {any} next
     * @returns {{ changed: string[] }}
     */
    load(next) {
      ir = next;
      if (state.runtimeProblems.length) set({ runtimeProblems: [] });
      const groups = next.groups ?? [];
      // The same groups keep the live-data subscription; the same IR keeps the visuals (doc/ui.md, Editor).
      const groupsKey = [...groups].sort().join(',');
      if (groupsKey !== followedKey) {
        followedKey = groupsKey;
        // The sky store traces the cause and keeps retrying (doc/sky-contract.md); the notice stays plain.
        sky.follow(groups).catch(() => set({ error: `Live data for ${groups.join(', ')} is unavailable. Sphärenmusik keeps trying; the console shows the details.` }));
      }
      const irKey = canonicalJson(next);
      if (irKey !== loadedKey) {
        loadedKey = irKey;
        propagator.setGroups(orbitGroupsOf(next));
        propagator.setOrbitSources(orbitSourcesOf(next));
        applyIrToVisuals();
      }
      set({ followed: [...groups] });
      if (host && host.runtime && (state.audio === 'playing')) {
        const r = host.reload(next);
        set({ playingIr: next });
        pushValues();
        return r;
      }
      return { changed: [] };
    },

    /**
     * Starts the piece with the loaded IR. Call synchronously inside the click handler.
     * @returns {Promise<void>}
     */
    run() {
      if (!host || !ir) return Promise.reject(new Error(host ? 'No piece is loaded' : 'The audio engine is still loading'));
      const pieceIr = ir;
      const token = ++runToken;
      const p = host.run(pieceIr);
      set({ audio: master?.muted ? 'muted' : 'starting', runtimeProblems: [] });
      return p.then(() => {
        // Stop, Panic or Restart Audio came while starting (doc/ui.md, Editor): they win.
        if (token !== runToken) { host?.stop(); return; }
        set({ audio: master?.muted ? 'muted' : 'playing', playingIr: pieceIr, notices: state.notices.filter((n) => n.kind !== 'fault' && n.kind !== 'engineFault') });
        if (valuesTimer === null) valuesTimer = setInterval(pushValues, LAYER_VALUES_MS);
        pushValues();
      }, (err) => {
        if (token !== runToken) return;
        set({ audio: 'stopped', error: `Run failed: ${err instanceof Error ? err.message : String(err)}` });
        throw err;
      });
    },

    stop() {
      runToken++;
      host?.stop();
      if (valuesTimer !== null) clearInterval(valuesTimer);
      valuesTimer = null;
      renderer?.setLayerValues({});
      set({ audio: master?.muted ? 'muted' : 'stopped', playingIr: null });
    },

    /** Panic: releases every voice, stops and mutes the master (doc/audio/audio-safety.md). */
    panic() {
      runToken++;
      if (!master) { host?.stop(); return; }
      master.panic();
      if (valuesTimer !== null) clearInterval(valuesTimer);
      valuesTimer = null;
      set({ audio: 'muted', playingIr: null, notices: [...state.notices, { id: ++noticeId, kind: 'panic', live: 'assertive', message: 'Panic: sound stopped and master muted' }] });
    },

    /** @param {number} detail click detail */
    reset(detail) {
      if (master?.reset(detail)) set({ audio: 'stopped', notices: state.notices.filter((n) => n.kind !== 'panic') });
    },

    /** @param {number} db */
    moveVolume(db) {
      if (!master) return;
      const wasMuted = master.muted;
      master.moveVolume(db);
      if (wasMuted) set({ audio: 'stopped', notices: state.notices.filter((n) => n.kind !== 'panic') });
    },

    restoreLevel() {
      master?.ack();
      set({ notices: state.notices.filter((n) => n.kind !== 'duck') });
    },

    /** Restart Audio after a safety-stage error (doc/audio/audio-safety.md, Wiring). */
    restartAudio() {
      if (!host) return Promise.resolve();
      runToken++;
      if (valuesTimer !== null) clearInterval(valuesTimer);
      valuesTimer = null;
      renderer?.setLayerValues({});
      return host.restartAudio().then(() => {
        set({ audio: 'stopped', playingIr: null, notices: state.notices.filter((n) => n.kind !== 'safetyError' && n.kind !== 'fault') });
      });
    },

    /** @param {number} id */
    dismiss(id) { set({ notices: state.notices.filter((n) => n.id !== id) }); },

    /**
     * Mounts the preview into `container`.
     * @param {HTMLElement} container
     * @param {{ installation?: boolean }} [o]
     * @returns {() => void} detach
     */
    attachPreview(container, { installation = false } = {}) {
      renderer?.dispose();
      renderer = mountVisuals(container, {
        sky,
        propagator,
        trace,
        pixelRatio: pixelRatioFor({ installation, previewScale: cfg.visual.previewScale, devicePixelRatio: globalThis.devicePixelRatio ?? 1 }),
        // The editor preview has a pixel budget; run and installation mode draw at full resolution (doc/visuals.md, Renderer).
        maxPixels: installation ? Infinity : PREVIEW_MAX_PIXELS,
        maxFps: MAX_FPS,
        reducedMotion: cfg.visual.reducedMotion,
        maxFlashesPerSecond: cfg.visual.maxFlashesPerSecond,
        observer: cfg.data.observer,
        audioClock: () => (host?.ctx ? audioNow(host.ctx) : null),
        // `audio.*` layer properties, evaluated per frame from the engine's analysis taps.
        frameValues: () => {
          const rt = host?.runtime;
          if (!rt || !ir || !hasAudioProps) return {};
          return computeLayerValues(ir, sky, (layer, obj) => rt.layerProps(layer, obj), audioDrivenProps);
        },
        groups: ir?.groups ?? [],
      });
      applyIrToVisuals();
      renderer.start();
      set({ visualsAvailable: renderer.available !== false });
      const mine = renderer;
      return () => {
        if (renderer === mine) { renderer.dispose(); renderer = null; }
      };
    },

    /** @param {string | null} objectId */
    highlight(objectId) { renderer?.highlight(objectId); },

    /** Applies validated settings to the renderer, propagator, master and trace buffer. @param {any} s */
    setSettings(s) {
      cfg = s;
      renderer?.setSettings({
        reducedMotion: s.visual.reducedMotion,
        maxFlashesPerSecond: s.visual.maxFlashesPerSecond,
        observer: s.data.observer,
      });
      propagator.setObserver(s.data.observer);
      master?.setLevel(s.audio.masterDb, s.audio.maxMasterDb);
      try { setCapacity(s.data.consoleBuffer); } catch { /* validated range */ }
    },

    /**
     * Switches to replay of the last `windowMs` at `speed` (doc/sky-contract.md, Replay mode).
     * @param {{ windowMs: number, speed: number }} o
     */
    async replay({ windowMs, speed }) {
      if (!client) throw new Error('Replay needs the database, which is unavailable');
      const to = Date.now();
      const from = to - windowMs;
      const replay = createReplay({ client, from, to, speed, trace, onEnd: () => set({ replay: state.replay ? { ...state.replay, ended: true } : null }) });
      const prev = sky.current;
      set({ mode: 'replay', replay: { speed, from, to, ended: false } });
      try {
        await sky.use(replay);
      } catch (err) {
        set({ error: `Replay failed: ${err instanceof Error ? err.message : String(err)}` });
      }
      propagator.setClock({ simMs: from, wallMs: Date.now(), speed, t0SimMs: from });
      if (prev !== replay) prev.close();
      if (prev === live) live = null;
    },

    /** Leaves replay or synthetic mode with a fresh live store. */
    async goLive() {
      const prev = sky.current;
      live = makeLive();
      set({ mode: 'live', replay: null });
      await sky.use(live).catch((err) => set({ error: `Going live failed: ${err instanceof Error ? err.message : String(err)}` }));
      const t = Date.now();
      propagator.setClock({ simMs: t, wallMs: t, speed: 1, t0SimMs: t });
      if (prev !== live) prev.close();
    },

    /** Synthetic triggers on the live store (`?dev=1`); null in replay or without a database. */
    synthetic() {
      const cur = sky.current;
      if (!cur || !cur._synthetic) return null;
      const syn = createSynthetic(cur);
      /** @param {Function} fn */
      const wrap = (fn) => (/** @type {any[]} */ ...a) => { const r = fn(...a); set({ mode: 'synthetic' }); return r; };
      return {
        enter: wrap(syn.enter),
        update: wrap(syn.update),
        exit: wrap(syn.exit),
        freshness: wrap(syn.freshness),
        clear: () => { const p = syn.clear(); set({ mode: 'live' }); return p; },
      };
    },

    clearError() { set({ error: null }); },

    dispose() {
      disposed = true;
      runToken++;
      if (valuesTimer !== null) clearInterval(valuesTimer);
      valuesTimer = null;
      try { host?.dispose(); } catch { /* engine already gone */ }
      renderer?.dispose();
      renderer = null;
      propagator.dispose();
      sky.close();
      sandbox?.dispose();
      listeners.clear();
    },
  };
  return session;
}
