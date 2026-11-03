/**
 * WebGL2 renderer (doc/visuals.md, Renderer and Interface). Pure logic lives
 * in scene.js, layer-state.js, projection.js and flash-guard.js; this module
 * owns the GL context, buffers and frame loop.
 */
import { diffLayers, PropResolver, ValueGate, isExprNode } from './layer-state.js';
import { buildSprites, buildSegments, objectScreenPosition, maxProp, trailRequest, linesRequest, SPRITE_STRIDE, SEGMENT_STRIDE, TRAIL_QUANTUM_SEC, SPAN_QUANTUM_MIN } from './scene.js';
import { orbitalCamera, fitRadiusKm, cameraAzimuth, earthDisc, mapRect, projectMap, projectSky, skyRadius, PROJECTIONS } from './projection.js';
import { createFlashGuard, createLimitTail, limitStep, GRID_W, GRID_H, MAX_LIMIT_DT_SEC, MAX_FLASHES_PER_SECOND } from './flash-guard.js';
import { isReducedMotion, watchSystemReducedMotion, clampPixelRatio, REDUCED_MOTION_STEP_MS } from './motion.js';
import { parseHex, isHexColor, COLORMAPS, mixRgb } from './color.js';
import { summaryLines, UNAVAILABLE_STATUS } from './summary.js';
import * as S from './shaders.js';
import { hasOrbit } from '../sky/groups.js';
import { DEFAULT_OBSERVER } from '../lib/settings.js';
import { safeTrace as wrapTrace } from '../trace/bus.js';

const DEG = Math.PI / 180;
const ATLAS_COLS = 16;
const ATLAS_CELL = 64;
const FIT_INTERVAL_MS = 1000;
const DESAT_RATE_PER_SEC = 1;
const EMPTY_POSITIONS = { ids: [], data: new Float32Array(0), stride: 8, index: new Map() };
/** A repeating frame error is traced at most this often. */
export const ERROR_REPEAT_MS = 1000;
/** Distinct frame error messages remembered; the oldest is forgotten first. */
const MAX_ERROR_MESSAGES = 32;

/**
 * @typedef {{
 *   sky?: any,
 *   propagator?: import('./propagator.js').Propagator | null,
 *   trace?: (record: any) => void,
 *   pixelRatio?: number,
 *   reducedMotion?: 'system' | 'on',
 *   maxFlashesPerSecond?: number,
 *   observer?: { lat: number, lon: number },
 *   audioClock?: (() => number | null) | null,
 *   frameValues?: ((audioTime: number) => any) | null,
 *   now?: () => number,
 *   raf?: (fn: FrameRequestCallback) => number,
 *   cancelRaf?: (id: number) => void,
 * }} RendererOptions
 */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {RendererOptions} [options]
 */
export function createRenderer(canvas, options = {}) {
  const trace = safeTrace(options.trace);
  const gl = /** @type {WebGL2RenderingContext | null} */ (
    canvas.getContext?.('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false }) ?? null
  );
  if (!gl) {
    trace(record('renderer', 'fallback', 'warn', { reason: 'webgl2' }));
    return unavailableRenderer(options);
  }
  return new Renderer(canvas, gl, options);
}

/** @param {RendererOptions} options */
function unavailableRenderer(options) {
  let groups = /** @type {string[]} */ ([]);
  let explicit = false;
  const noop = () => {};
  return {
    available: false,
    statusText: UNAVAILABLE_STATUS,
    /** @param {any[]} layers */
    setLayers(layers) { if (!explicit) groups = (layers ?? []).map((l) => l?.group).filter(Boolean); },
    /** @param {string[]} g */
    setGroups(g) { groups = Array.isArray(g) ? [...g] : []; explicit = true; },
    summaryLines() { return options.sky ? summaryLines(groups, options.sky) : []; },
    setView: noop, setLayerValues: noop, setBackground: noop, setDesaturate: noop, setSettings: noop,
    start: noop, stop: noop, highlight: noop, dispose: noop,
  };
}

/**
 * A trace function that never throws into the frame loop.
 * @param {((record: any) => void) | undefined} fn
 */
export function safeTrace(fn) {
  return wrapTrace(fn, 'visual');
}

/**
 * Rate limit for a repeating error: `report(message, nowMs)` calls `emit({ message })`
 * the first time a message occurs, then `emit({ message, repeats })` at most once per
 * `intervalMs` while it repeats, with the count since the previous record.
 * @param {(data: { message: string, repeats?: number }) => void} emit
 * @param {number} [intervalMs]
 */
export function createErrorThrottle(emit, intervalMs = ERROR_REPEAT_MS) {
  /** @type {Map<string, { repeats: number, lastAt: number }>} */
  const seen = new Map();
  return (/** @type {string} */ message, /** @type {number} */ nowMs) => {
    const s = seen.get(message);
    if (!s) {
      if (seen.size >= MAX_ERROR_MESSAGES) seen.delete(/** @type {string} */ (seen.keys().next().value));
      seen.set(message, { repeats: 0, lastAt: nowMs });
      emit({ message });
      return;
    }
    s.repeats++;
    if (nowMs - s.lastAt >= intervalMs) {
      emit({ message, repeats: s.repeats });
      s.repeats = 0;
      s.lastAt = nowMs;
    }
  };
}

/**
 * @param {string} component @param {string} event @param {string} level @param {any} data @param {string} [traceId]
 */
function record(component, event, level, data, traceId) {
  return { t: new Date().toISOString(), traceId: traceId ?? `visual-${component}-${Date.now()}`, stage: 'VISUAL', component, event, level, data };
}

class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas @param {WebGL2RenderingContext} gl @param {RendererOptions} o
   */
  constructor(canvas, gl, o) {
    this.available = true;
    this.statusText = '';
    this.canvas = canvas;
    this.gl = gl;
    this.sky = o.sky ?? null;
    this.propagator = o.propagator ?? null;
    this.trace = safeTrace(o.trace);
    this.now = o.now ?? (() => Date.now());
    this.raf = o.raf ?? ((fn) => requestAnimationFrame(fn));
    this.cancelRaf = o.cancelRaf ?? ((id) => cancelAnimationFrame(id));
    this.audioClock = o.audioClock ?? null;
    this.frameValues = o.frameValues ?? null;
    this.settings = {
      pixelRatio: clampPixelRatio(o.pixelRatio ?? 1),
      reducedMotion: o.reducedMotion ?? 'system',
      maxFlashesPerSecond: o.maxFlashesPerSecond ?? MAX_FLASHES_PER_SECOND,
      observer: o.observer ?? { ...DEFAULT_OBSERVER },
    };
    this.systemReduced = false;
    this.unwatchMotion = watchSystemReducedMotion((r) => { this.systemReduced = r; });
    /** @type {Map<string, import('./layer-state.js').LayerState>} */
    this.layers = new Map();
    /** @type {import('./layer-state.js').LayerState[]} */
    this.order = [];
    this.view = { projection: 'orbital', background: '#05070c' };
    this.backgroundExpr = false;
    this.background = '#05070c';
    this.heldBackground = this.background;
    this.pushed = {};
    this.resolver = new PropResolver();
    this.gate = new ValueGate(REDUCED_MOTION_STEP_MS);
    this.guard = createFlashGuard({ maxFlashesPerSecond: this.settings.maxFlashesPerSecond, encoding: 'linear', measured: 'output', trace: this.trace });
    this.sceneGuard = createFlashGuard({ maxFlashesPerSecond: this.settings.maxFlashesPerSecond, encoding: 'linear', measured: 'scene', trace: this.trace });
    this.limitTail = createLimitTail();
    this.desatTarget = 0;
    this.desat = 0;
    /** @type {string | null} */
    this.highlighted = null;
    /** @type {Map<string, number>} */
    this.lastEventMs = new Map();
    /** @type {Map<string, number>} aurora drift phase per layer */
    this.auroraPhase = new Map();
    /** @type {Map<string, { tex: WebGLTexture, key: string }>} grid cell textures per layer */
    this.gridTex = new Map();
    this.pathKey = '';
    this.fitKm = fitRadiusKm([]);
    this.lastFitAt = -Infinity;
    this.startedAt = this.now();
    this.lastFrameAt = 0;
    this.rafId = 0;
    this.running = false;
    this.lost = false;
    /** @type {Map<string, WebGLProgram | null>} */
    this.userPrograms = new Map();
    this.glyphs = new Map([['+', 0]]);
    this.glyphDirty = true;
    this.guardPixels = new Uint8Array(GRID_W * GRID_H * 8); // output grid, then scene grid
    this.scratch = new Float32Array(8);
    this.frameError = createErrorThrottle((data) => this.trace(record('renderer', 'frameError', 'error', data)));
    this.unsubSky = this.sky ? ['enter', 'update', 'exit'].map((t) => this.sky.on(t, (e) => this.onSkyEvent(e))) : [];
    this.onLost = (/** @type {Event} */ e) => {
      e.preventDefault();
      this.lost = true;
      this.trace(record('renderer', 'contextLost', 'error', {}));
    };
    this.onRestored = () => { this.lost = false; this.initGl(); this.glyphDirty = true; };
    canvas.addEventListener?.('webglcontextlost', this.onLost);
    canvas.addEventListener?.('webglcontextrestored', this.onRestored);
    this.initGl();
  }

  // ---- public API ----

  /** @param {{ projection?: string, background?: unknown }} view */
  setView(view) {
    const projection = PROJECTIONS.includes(/** @type {string} */ (view?.projection)) ? /** @type {string} */ (view.projection) : 'orbital';
    this.view = { projection, background: /** @type {any} */ (view?.background) };
    this.backgroundExpr = isExprNode(view?.background);
    if (isHexColor(view?.background)) this.background = /** @type {string} */ (view.background).toLowerCase();
    this.pathKey = '';
  }

  /** @param {any[]} entries */
  setLayers(entries) {
    const d = diffLayers(this.layers, entries);
    for (const e of d.errors) this.trace(record('renderer', 'layerError', 'error', e));
    for (const id of [...d.changed, ...d.removed]) {
      this.resolver.forget(id);
      const prog = this.userPrograms.get(id);
      if (prog) this.gl.deleteProgram(prog);
      this.userPrograms.delete(id);
    }
    this.layers = new Map(d.layers.map((l) => [l.id, l]));
    this.order = d.layers;
    for (const l of this.order) if (l.type === 'shader' && !this.userPrograms.has(l.id)) this.compileUser(l);
    this.pathKey = '';
  }

  /** @param {any} values LayerValues */
  setLayerValues(values) {
    this.pushed = values && typeof values === 'object' ? values : {};
  }

  /** @param {unknown} color */
  setBackground(color) {
    if (isHexColor(color)) this.background = /** @type {string} */ (color).toLowerCase();
  }

  /** @param {number} amount */
  setDesaturate(amount) {
    this.desatTarget = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0;
  }

  /** @param {Partial<{ pixelRatio: number, reducedMotion: 'system' | 'on', maxFlashesPerSecond: number, observer: { lat: number, lon: number } }>} p */
  setSettings(p) {
    if (p.pixelRatio !== undefined) this.settings.pixelRatio = clampPixelRatio(p.pixelRatio);
    if (p.reducedMotion !== undefined) this.settings.reducedMotion = p.reducedMotion;
    if (p.maxFlashesPerSecond !== undefined) {
      // Throws RangeError for a non-finite limit before anything changes (doc/visuals.md, Visual safety).
      this.guard.setMaxFlashes(p.maxFlashesPerSecond);
      this.sceneGuard.setMaxFlashes(p.maxFlashesPerSecond);
      this.settings.maxFlashesPerSecond = p.maxFlashesPerSecond;
    }
    if (p.observer) this.settings.observer = p.observer;
  }

  /** @param {string | null} objectId */
  highlight(objectId) { this.highlighted = objectId; }

  /** Followed groups, used by the text summary. @param {string[]} groups */
  setGroups(groups) { this.groups = Array.isArray(groups) ? [...groups] : []; }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrameAt = 0;
    const loop = (/** @type {number} */ t) => {
      if (!this.running) return;
      try { this.frame(t); } catch (err) {
        this.frameError(err instanceof Error ? err.message : String(err), this.now());
      }
      this.rafId = this.raf(loop);
    };
    this.rafId = this.raf(loop);
  }

  stop() {
    this.running = false;
    if (this.rafId) this.cancelRaf(this.rafId);
    this.rafId = 0;
  }

  summaryLines() {
    const groups = this.groups ?? this.order.map((l) => l.group).filter((g) => g !== null);
    return this.sky ? summaryLines(groups, this.sky) : [];
  }

  dispose() {
    this.stop();
    for (const u of this.unsubSky) u();
    this.unwatchMotion();
    this.canvas.removeEventListener?.('webglcontextlost', this.onLost);
    this.canvas.removeEventListener?.('webglcontextrestored', this.onRestored);
    const gl = this.gl;
    for (const p of this.userPrograms.values()) if (p) gl.deleteProgram(p);
    for (const p of Object.values(this.prog ?? {})) gl.deleteProgram(p);
    for (const b of Object.values(this.buf ?? {})) gl.deleteBuffer(b);
    for (const v of Object.values(this.vao ?? {})) gl.deleteVertexArray(v);
    for (const t of [...(this.targets ?? []), this.guardTarget, this.boxTarget]) if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    gl.deleteTexture(this.atlas);
    for (const g of this.gridTex.values()) gl.deleteTexture(g.tex);
    this.gridTex.clear();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  // ---- events ----

  /** @param {any} e SkyEvent */
  onSkyEvent(e) {
    const obj = e?.obj;
    if (!obj) return;
    if (e.type === 'exit') { this.lastEventMs.delete(obj.id); this.resolver.forgetObject(obj.id); }
    else this.lastEventMs.set(obj.id, this.now());
    for (const l of this.order) {
      if (l.group !== obj.group) continue;
      this.trace({
        t: new Date(this.now()).toISOString(), traceId: e.traceId, stage: 'VISUAL', component: `layer.${l.id}`, event: e.type, level: 'info',
        data: { layer: l.id, objectId: obj.id },
      });
    }
  }

  // ---- GL setup ----

  initGl() {
    const gl = this.gl;
    this.prog = {
      sprite: this.program(S.SPRITE_VS, S.SPRITE_FS),
      segment: this.program(S.SEGMENT_VS, S.SEGMENT_FS),
      field: this.program(S.FULLSCREEN_VS, S.FIELD_FS),
      aurora: this.program(S.FULLSCREEN_VS, S.AURORA_FS),
      grid: this.program(S.FULLSCREEN_VS, S.GRID_FS),
      composite: this.program(S.FULLSCREEN_VS, S.COMPOSITE_FS),
      copy: this.program(S.FULLSCREEN_VS, S.COPY_FS),
      guardBox: this.program(S.FULLSCREEN_VS, S.GUARD_BOX_FS),
      guard: this.program(S.FULLSCREEN_VS, S.GUARD_FS),
    };
    this.buf = { quad: gl.createBuffer(), sprite: gl.createBuffer(), segment: gl.createBuffer() };
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = { sprite: this.spriteVao(), segment: this.segmentVao(), empty: gl.createVertexArray() };
    this.atlas = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(1));
    this.glyphDirty = true;
    // Float output targets keep storage rounding out of the limited step (doc/visuals.md, Visual safety).
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
    this.targets = [];
    this.size = { w: 0, h: 0 };
    this.primed = false;
    this.guardTarget = this.target(GRID_W, GRID_H * 2);
    this.boxTarget = this.target(GRID_W * 8, GRID_H * 8, this.floatTargets);
    for (const l of this.order) if (l.type === 'shader') this.compileUser(l);
  }

  /** @param {string} vs @param {string} fs */
  program(vs, fs) {
    const gl = this.gl;
    const p = /** @type {WebGLProgram} */ (gl.createProgram());
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = /** @type {WebGLShader} */ (gl.createShader(/** @type {number} */ (type)));
      gl.shaderSource(s, /** @type {string} */ (src));
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s) ?? '';
        gl.deleteShader(s);
        gl.deleteProgram(p);
        throw new ShaderError(log);
      }
      gl.attachShader(p, s);
      gl.deleteShader(s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p) ?? '';
      gl.deleteProgram(p);
      throw new ShaderError(log);
    }
    return p;
  }

  /** @param {import('./layer-state.js').LayerState} l */
  compileUser(l) {
    try {
      this.userPrograms.set(l.id, this.program(S.FULLSCREEN_VS, S.userShaderSource(/** @type {string} */ (l.glsl))));
    } catch (err) {
      this.userPrograms.set(l.id, null);
      this.trace(record(`layer.${l.id}`, 'shaderError', 'error', { layer: l.id, log: err instanceof Error ? err.message : String(err) }));
    }
  }

  spriteVao() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.sprite);
    const st = SPRITE_STRIDE * 4;
    /** @type {[number, number, number][]} location, size, offset (floats) */
    const attrs = [[1, 2, 0], [2, 1, 2], [3, 1, 3], [4, 4, 4], [5, 1, 8]];
    for (const [loc, size, off] of attrs) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, st, off * 4);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  segmentVao() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.segment);
    const st = SEGMENT_STRIDE * 4;
    for (const [loc, size, off] of [[1, 4, 0], [2, 1, 4], [3, 4, 5]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, st, off * 4);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  /** @param {number} w @param {number} h @param {boolean} [float] 32-bit float storage, sampled NEAREST */
  target(w, h, float = false) {
    const gl = this.gl;
    const tex = /** @type {WebGLTexture} */ (gl.createTexture());
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const filter = float ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = /** @type {WebGLFramebuffer} */ (gl.createFramebuffer());
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }

  resize() {
    const ratio = this.settings.pixelRatio;
    const cssW = this.canvas.clientWidth || this.canvas.width || 1;
    const cssH = this.canvas.clientHeight || this.canvas.height || 1;
    const w = Math.max(1, Math.round(cssW * ratio));
    const h = Math.max(1, Math.round(cssH * ratio));
    if (w === this.size.w && h === this.size.h) return;
    const gl = this.gl;
    this.canvas.width = w;
    this.canvas.height = h;
    const old = this.targets;
    const lastOut = old.length ? old[this.outIndex === 1 ? 2 : 1] : null;
    // scene, output A, output B
    this.targets = [this.target(w, h), this.target(w, h, this.floatTargets), this.target(w, h, this.floatTargets)];
    this.outIndex = 1;
    this.size = { w, h };
    if (lastOut && this.primed) {
      // The next frame limits change against the last output, scaled, so a resize never lifts the limit.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[2].fbo);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);
      gl.useProgram(this.prog.copy);
      this.bindTex(this.prog.copy, 'uSrc', lastOut.tex, 0);
      this.u2(this.prog.copy, 'uRes', w, h);
      this.fullscreen();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      this.primed = false;
    }
    for (const t of old) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
  }

  // ---- frame ----

  /** @param {number} perfMs */
  frame(perfMs) {
    if (this.lost) return;
    const gl = this.gl;
    const nowMs = this.now();
    const dt = this.lastFrameAt ? (perfMs - this.lastFrameAt) / 1000 : 1 / 60;
    this.lastFrameAt = perfMs;
    this.resize();
    const { w, h } = this.size;
    const reduced = isReducedMotion(this.settings.reducedMotion, this.systemReduced);
    const holding = this.guard.limiting || this.sceneGuard.limiting;

    let frameVals = null;
    const audioTime = this.audioClock ? this.audioClock() : null;
    if (this.frameValues && audioTime !== null && Number.isFinite(audioTime)) {
      try { frameVals = this.frameValues(/** @type {number} */ (audioTime)); } catch (err) {
        this.trace(record('renderer', 'frameValuesError', 'error', { message: err instanceof Error ? err.message : String(err) }));
      }
    }
    const sources = this.gate.offer({ pushed: this.pushed, frame: frameVals, background: this.background }, perfMs, reduced);

    const positions = this.propagator?.positions(nowMs) ?? EMPTY_POSITIONS;
    const simMs = /** @type {any} */ (this.propagator)?.simTime?.(nowMs) ?? nowMs;
    const projection = this.view.projection;
    if (projection === 'orbital' && nowMs - this.lastFitAt >= FIT_INTERVAL_MS) {
      this.fitKm = fitRadiusKm(positions.data);
      this.lastFitAt = nowMs;
    }
    const cam = projection === 'orbital'
      ? orbitalCamera({ width: w, height: h, fitRadiusKm: this.fitKm, azimuthRad: cameraAzimuth(nowMs - this.startedAt, reduced) })
      : undefined;
    const view = { width: w, height: h, cam };
    const ctx = { simMs, observer: this.settings.observer, scratch: this.scratch };

    // Background, held while the guard intervenes when it is an expression.
    if (!(holding && this.backgroundExpr)) this.heldBackground = sources.background;
    const bg = parseHex(this.heldBackground) ?? [0, 0, 0];

    const [scene, outA, outB] = this.targets;
    const out = this.outIndex === 1 ? outA : outB;
    const prev = this.outIndex === 1 ? outB : outA;

    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this.drawDecorations(projection, view, bg);

    /** @type {Map<string, any[]>} */
    const groupCache = new Map();
    const objectsOf = (/** @type {string} */ g) => {
      if (!groupCache.has(g)) groupCache.set(g, this.sky?.get(g) ?? []);
      return /** @type {any[]} */ (groupCache.get(g));
    };
    const pathRequests = [];
    const simNow = simMs;

    for (const layer of this.order) {
      // Once per object and frame: trails, sprites and paths all read the same values.
      /** @type {Map<string | null, Record<string, number | string>>} */
      const resolved = new Map();
      const resolve = (/** @type {string | null} */ id) => {
        let v = resolved.get(id);
        if (v === undefined) { v = this.resolver.resolve(layer, id, { frame: sources.frame, pushed: sources.pushed, reducedMotion: reduced, holdColors: holding }); resolved.set(id, v); }
        return v;
      };
      if (layer.type === 'points' || layer.type === 'rings' || layer.type === 'glyph') {
        const objects = objectsOf(/** @type {string} */ (layer.group));
        if (layer.type === 'points' && hasOrbit(String(layer.group))) {
          const byId = new Map(objects.map((o) => [o.id, o]));
          const maxTrail = maxProp(objects, resolve, 'trail', TRAIL_QUANTUM_SEC);
          if (maxTrail > 0) {
            const key = `trail:${layer.id}`;
            pathRequests.push(trailRequest(key, String(layer.group), maxTrail));
            this.drawPaths(key, objects, projection, view, simNow, (id) => {
              const p = resolve(id);
              const trail = /** @type {number} */ (p.trail);
              return trail > 0 ? { fromSec: -trail, toSec: 0, color: /** @type {string} */ (p.color), opacity: /** @type {number} */ (p.opacity), fadeSec: trail } : null;
            }, (id) => {
              const obj = byId.get(id);
              return obj ? objectScreenPosition(obj, positions, projection, view, ctx) : null;
            });
          }
        }
        const sprites = buildSprites({
          layer, objects, positions, projection, view, ctx, resolve, pixelRatio: this.settings.pixelRatio, nowMs,
          lastEventMs: this.lastEventMs, glyphIndex: (ch) => this.glyphIndex(ch),
        });
        this.drawSprites(layer.type === 'points' ? 0 : layer.type === 'rings' ? 1 : 2, sprites.data, sprites.count);
      } else if (layer.type === 'lines') {
        const objects = objectsOf(/** @type {string} */ (layer.group));
        if (!hasOrbit(String(layer.group))) continue;
        const maxSpan = maxProp(objects, resolve, 'span', SPAN_QUANTUM_MIN);
        const key = `lines:${layer.id}`;
        pathRequests.push(linesRequest(key, String(layer.group), maxSpan));
        this.drawPaths(key, objects, projection, view, simNow, (id) => {
          const p = resolve(id);
          const half = /** @type {number} */ (p.span) * 30;
          return { fromSec: -half, toSec: half, color: /** @type {string} */ (p.color), opacity: /** @type {number} */ (p.opacity) };
        });
      } else if (layer.type === 'field') {
        this.drawField(resolve(null), w, h);
      } else if (layer.type === 'aurora') {
        this.drawAurora(resolve(null), projection, w, h, perfMs, dt, reduced, layer.id);
      } else if (layer.type === 'grid') {
        this.drawGrid(layer.id, resolve(null), w, h);
      } else if (layer.type === 'shader') {
        this.drawUser(layer, resolve(null), w, h, perfMs);
      }
    }

    if (this.highlighted) this.drawHighlight(positions, projection, view, ctx);

    const key = JSON.stringify(pathRequests);
    if (key !== this.pathKey) { this.pathKey = key; this.propagator?.setPaths(pathRequests); }

    // Composite: desaturate and limit change, into the output target.
    const desatStep = DESAT_RATE_PER_SEC * Math.min(Math.max(dt, 0), MAX_LIMIT_DT_SEC);
    this.desat += Math.max(-desatStep, Math.min(desatStep, this.desatTarget - this.desat));
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog.composite);
    this.bindTex(this.prog.composite, 'uScene', scene.tex, 0);
    this.bindTex(this.prog.composite, 'uPrev', prev.tex, 1);
    this.u2(this.prog.composite, 'uRes', w, h);
    this.u1(this.prog.composite, 'uDesat', this.desat);
    this.u1(this.prog.composite, 'uStep', this.limitTail.active(holding) && this.primed ? limitStep(dt) : -1);
    this.u1(this.prog.composite, 'uQuantize', this.floatTargets ? 0 : 1);
    this.fullscreen();

    // Present.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog.copy);
    this.bindTex(this.prog.copy, 'uSrc', out.tex, 0);
    this.u2(this.prog.copy, 'uRes', w, h);
    this.fullscreen();

    // Flash guard readback: the output in rows 0–47, the scene before the limit in rows 48–95.
    this.measure(out.tex, 0, w, h);
    this.measure(scene.tex, GRID_H, w, h);
    const gt = this.guardTarget;
    gl.bindFramebuffer(gl.FRAMEBUFFER, gt.fbo);
    gl.readPixels(0, 0, gt.w, gt.h, gl.RGBA, gl.UNSIGNED_BYTE, this.guardPixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const cells = GRID_W * GRID_H * 4;
    this.guard.frame(this.guardPixels.subarray(0, cells), perfMs);
    this.sceneGuard.frame(this.guardPixels.subarray(cells), perfMs);
    this.limitTail.after(holding, this.guard.limiting || this.sceneGuard.limiting, dt);

    this.outIndex = this.outIndex === 1 ? 2 : 1;
    this.primed = true;
  }

  /**
   * Averages `tex` into the guard grid at row `row` of the readback target; every pixel counts.
   * @param {WebGLTexture} tex @param {number} row @param {number} w @param {number} h
   */
  measure(tex, row, w, h) {
    const gl = this.gl;
    const bt = this.boxTarget;
    gl.bindFramebuffer(gl.FRAMEBUFFER, bt.fbo);
    gl.viewport(0, 0, bt.w, bt.h);
    gl.useProgram(this.prog.guardBox);
    this.bindTex(this.prog.guardBox, 'uSrc', tex, 0);
    this.u2(this.prog.guardBox, 'uSrcSize', w, h);
    this.u2(this.prog.guardBox, 'uDstSize', bt.w, bt.h);
    this.fullscreen();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.guardTarget.fbo);
    gl.viewport(0, row, GRID_W, GRID_H);
    gl.useProgram(this.prog.guard);
    this.bindTex(this.prog.guard, 'uBoxes', bt.tex, 0);
    this.u2(this.prog.guard, 'uSrcSize', w, h);
    this.u2(this.prog.guard, 'uBoxSize', bt.w, bt.h);
    this.u1(this.prog.guard, 'uRowOffset', row);
    this.fullscreen();
  }

  // ---- drawing ----

  /** @param {number} kind @param {Float32Array} data @param {number} count */
  drawSprites(kind, data, count) {
    if (!count) return;
    const gl = this.gl;
    if (kind === 2 && this.glyphDirty) this.buildAtlas();
    gl.useProgram(this.prog.sprite);
    this.u2(this.prog.sprite, 'uRes', this.size.w, this.size.h);
    gl.uniform1i(gl.getUniformLocation(this.prog.sprite, 'uKind'), kind);
    this.bindTex(this.prog.sprite, 'uAtlas', this.atlas, 0);
    this.u1(this.prog.sprite, 'uAtlasCols', ATLAS_COLS);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.sprite);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(this.vao.sprite);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
  }

  /** @param {Float32Array} data @param {number} count */
  drawSegmentData(data, count) {
    if (!count) return;
    const gl = this.gl;
    gl.useProgram(this.prog.segment);
    this.u2(this.prog.segment, 'uRes', this.size.w, this.size.h);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.segment);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(this.vao.segment);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
  }

  /**
   * @param {string} key @param {any[]} objects @param {string} projection @param {any} view @param {number} simNow
   * @param {(id: string) => any} window @param {(id: string) => any} [head]
   */
  drawPaths(key, objects, projection, view, simNow, window, head) {
    const paths = this.propagator?.paths(key) ?? null;
    if (!paths) return;
    const seg = buildSegments({
      paths, objects, projection, view, simNowMs: simNow, pathSimMs: paths.simMs ?? simNow, window, head, pixelRatio: this.settings.pixelRatio,
    });
    this.drawSegmentData(seg.data, seg.count);
  }

  /** Earth disc in `orbital`, graticule in `map`, elevation circles in `sky`. */
  drawDecorations(projection, view, bg) {
    const { width: w, height: h } = view;
    const line = mixRgb(bg, [1, 1, 1], 0.12);
    const r = this.settings.pixelRatio;
    if (projection === 'orbital') {
      const d = earthDisc(view.cam);
      const fill = mixRgb(bg, [0.35, 0.5, 0.75], 0.18);
      this.drawSprites(0, new Float32Array([d.x, d.y, d.r * 2, 0, fill[0], fill[1], fill[2], 1, 0]), 1);
      this.drawSprites(1, new Float32Array([d.x, d.y, d.r, r, line[0], line[1], line[2], 1, 0]), 1);
      return;
    }
    /** @type {number[]} */
    const segs = [];
    const push = (a, b) => { if (a && b) segs.push(a.x, a.y, b.x, b.y, r, line[0], line[1], line[2], 1); };
    if (projection === 'map') {
      for (let lon = -180; lon <= 180; lon += 30) push(projectMap(90 * DEG, lon * DEG, w, h), projectMap(-90 * DEG, lon * DEG, w, h));
      for (let lat = -90; lat <= 90; lat += 30) push(projectMap(lat * DEG, -Math.PI, w, h), projectMap(lat * DEG, Math.PI, w, h));
    } else {
      for (const el of [0, 30, 60]) {
        const n = 96;
        for (let i = 0; i < n; i++) push(projectSky((i / n) * 2 * Math.PI, el * DEG, w, h), projectSky(((i + 1) / n) * 2 * Math.PI, el * DEG, w, h));
      }
    }
    this.drawSegmentData(new Float32Array(segs), segs.length / SEGMENT_STRIDE);
  }

  /** @param {Record<string, any>} p @param {number} w @param {number} h */
  drawField(p, w, h) {
    const gl = this.gl;
    const prog = this.prog.field;
    gl.useProgram(prog);
    const stops = (COLORMAPS[p.colormap] ?? COLORMAPS.night).flatMap((hex) => /** @type {number[]} */ (parseHex(hex)));
    gl.uniform3fv(gl.getUniformLocation(prog, 'uStops'), new Float32Array(stops));
    this.u2(prog, 'uRes', w, h);
    this.u1(prog, 'uValue', p.value);
    this.u1(prog, 'uOpacity', p.opacity);
    this.fullscreen();
  }

  /**
   * @param {Record<string, any>} p @param {string} projection @param {number} w @param {number} h
   * @param {number} perfMs @param {number} dt @param {boolean} reduced @param {string} id
   */
  drawAurora(p, projection, w, h, perfMs, dt, reduced, id) {
    if (!(p.intensity > 0) || !(p.opacity > 0)) return;
    const phase = (this.auroraPhase.get(id) ?? 0) + (reduced ? 0 : p.drift * 0.05 * Math.min(dt, 0.1));
    this.auroraPhase.set(id, phase % 1000);
    const gl = this.gl;
    const prog = this.prog.aurora;
    gl.useProgram(prog);
    const rect = mapRect(w, h);
    gl.uniform1i(gl.getUniformLocation(prog, 'uMode'), projection === 'map' ? 1 : projection === 'sky' ? 2 : 0);
    gl.uniform4f(gl.getUniformLocation(prog, 'uRect'), rect.x, rect.y, rect.w, rect.h);
    this.u1(prog, 'uSkyR', skyRadius(w, h));
    this.u2(prog, 'uRes', w, h);
    this.u1(prog, 'uPhase', phase);
    this.u1(prog, 'uIntensity', p.intensity);
    this.u1(prog, 'uOpacity', p.opacity);
    this.fullscreen();
  }

  /**
   * Square cells in the largest centred area that fits in 92% of the canvas; cell colours go to a
   * cols × rows texture, uploaded only when they change.
   * @param {string} id @param {Record<string, any>} p @param {number} w @param {number} h
   */
  drawGrid(id, p, w, h) {
    if (!(p.opacity > 0)) return;
    const gl = this.gl;
    const cols = Math.max(1, Math.round(p.cols));
    const rows = Math.max(1, Math.round(p.rows));
    const cells = Array.isArray(p.cells) ? p.cells : [];
    let g = this.gridTex.get(id);
    if (!g) {
      const tex = /** @type {WebGLTexture} */ (gl.createTexture());
      gl.bindTexture(gl.TEXTURE_2D, tex);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      g = { tex, key: '' };
      this.gridTex.set(id, g);
    }
    const key = `${cols}x${rows}:${cells.join(',')}`;
    if (key !== g.key) {
      g.key = key;
      const data = new Uint8Array(cols * rows * 4);
      for (let i = 0; i < cols * rows; i++) {
        const rgb = parseHex(cells[i]);
        if (!rgb) continue; // alpha 0: the cell shows the background
        data.set([Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255), 255], i * 4);
      }
      gl.bindTexture(gl.TEXTURE_2D, g.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }
    const cell = Math.floor(Math.min((w * 0.92) / cols, (h * 0.92) / rows));
    if (cell < 1) return;
    const aw = cell * cols, ah = cell * rows;
    const prog = this.prog.grid;
    gl.useProgram(prog);
    this.bindTex(prog, 'uCells', g.tex, 0);
    this.u2(prog, 'uRes', w, h);
    gl.uniform4f(gl.getUniformLocation(prog, 'uArea'), Math.round((w - aw) / 2), Math.round((h - ah) / 2), aw, ah);
    this.u2(prog, 'uGrid', cols, rows);
    this.u1(prog, 'uGap', Math.min(p.gap * this.settings.pixelRatio, cell / 2));
    const bg = parseHex(p.background) ?? [0, 0, 0];
    gl.uniform3f(gl.getUniformLocation(prog, 'uBackground'), bg[0], bg[1], bg[2]);
    this.u1(prog, 'uOpacity', p.opacity);
    this.fullscreen();
  }

  /** @param {import('./layer-state.js').LayerState} layer @param {Record<string, any>} p @param {number} w @param {number} h @param {number} perfMs */
  drawUser(layer, p, w, h, perfMs) {
    const prog = this.userPrograms.get(layer.id);
    if (!prog || !(p.opacity > 0)) return;
    this.gl.useProgram(prog);
    this.u1(prog, 'uTime', (this.now() - this.startedAt) / 1000);
    this.u2(prog, 'uResolution', w, h);
    this.u1(prog, 'uOpacity', p.opacity);
    this.fullscreen();
  }

  drawHighlight(positions, projection, view, ctx) {
    const obj = this.sky?.object(/** @type {string} */ (this.highlighted)) ?? null;
    if (!obj) return;
    const pos = objectScreenPosition(obj, positions, projection, view, ctx);
    if (!pos) return;
    const r = this.settings.pixelRatio;
    this.drawSprites(1, new Float32Array([pos.x, pos.y, 10 * r, 1.5 * r, 1, 1, 1, 0.9, 0]), 1);
  }

  fullscreen() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao.empty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** @param {string} ch */
  glyphIndex(ch) {
    let i = this.glyphs.get(ch);
    if (i !== undefined) return i;
    if (this.glyphs.size >= ATLAS_COLS * ATLAS_COLS) return 0;
    i = this.glyphs.size;
    this.glyphs.set(ch, i);
    this.glyphDirty = true;
    return i;
  }

  buildAtlas() {
    this.glyphDirty = false;
    const size = ATLAS_COLS * ATLAS_CELL;
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
    const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    g.clearRect(0, 0, size, size);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `${Math.round(ATLAS_CELL * 0.8)}px ui-monospace, monospace`;
    for (const [ch, i] of this.glyphs) {
      g.fillText(ch, (i % ATLAS_COLS + 0.5) * ATLAS_CELL, (Math.floor(i / ATLAS_COLS) + 0.5) * ATLAS_CELL);
    }
    const img = g.getImageData(0, 0, size, size);
    // Alpha into the red channel; row 0 of the texture is the top of the image.
    const red = new Uint8Array(size * size);
    for (let i = 0; i < red.length; i++) red[i] = img.data[i * 4 + 3];
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, red);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** @param {WebGLProgram} p @param {string} name @param {WebGLTexture | null} tex @param {number} unit */
  bindTex(p, name, tex, unit) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(p, name), unit);
  }

  /** @param {WebGLProgram} p @param {string} name @param {number} x */
  u1(p, name, x) { this.gl.uniform1f(this.gl.getUniformLocation(p, name), x); }

  /** @param {WebGLProgram} p @param {string} name @param {number} x @param {number} y */
  u2(p, name, x, y) { this.gl.uniform2f(this.gl.getUniformLocation(p, name), x, y); }
}

class ShaderError extends Error {}

