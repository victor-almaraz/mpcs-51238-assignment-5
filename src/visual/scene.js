/**
 * Per-frame scene building: object positions, resolved properties and
 * instance data for each layer (doc/visuals.md, Object positions, Layer
 * properties). Pure: the renderer uploads the arrays to the GPU.
 */
import { parseHex } from './color.js';
import { projectRecord, viewCentre, surfaceRecord, mapRect } from './projection.js';
import { STRIDE } from './propagation-core.js';
import { hasOrbit } from '../sky/groups.js';

/** Floats per sprite instance: x, y, size, width, r, g, b, a, glyph. */
export const SPRITE_STRIDE = 9;
/** Floats per segment instance: x0, y0, x1, y1, width, r, g, b, a. */
export const SEGMENT_STRIDE = 9;
/** Opacity factor of objects behind Earth in `orbital`. */
export const OCCLUDED_ALPHA = 0.25;
/** Lines and trails are drawn this wide, in CSS pixels. */
export const PATH_WIDTH = 1;
const WHITE = [1, 1, 1];

/**
 * Groups drawn at a point on Earth's surface: the fields holding latitude and
 * longitude in degrees (doc/visuals.md, Object positions).
 * @type {Readonly<Record<string, { lat: string, lon: string }>>}
 */
export const SURFACE_FIELDS = Object.freeze({ 'll2.upcoming': Object.freeze({ lat: 'padLat', lon: 'padLon' }) });

/** Trail requests round the longest trail up to this many seconds. */
export const TRAIL_QUANTUM_SEC = 60;
/** Trails start this many seconds earlier than the longest trail, so the oldest end is covered between path updates. */
export const TRAIL_MARGIN_SEC = 5;
/** Samples per trail; the step is the trail length divided by this, at least MIN_TRAIL_STEP_SEC. */
export const TRAIL_SAMPLES = 60;
export const MIN_TRAIL_STEP_SEC = 1;
/** Line requests round the longest `span` up to this many minutes. */
export const SPAN_QUANTUM_MIN = 10;
/** Lines are sampled once per minute (doc/visuals.md, Property meanings). */
export const LINE_STEP_SEC = 60;

/**
 * Where an object is drawn.
 * @param {any} obj SkyObject
 * @param {{ ids: string[], data: Float32Array, index: Map<string, number> }} positions
 * @param {string} projection
 * @param {{ width: number, height: number, cam?: any }} view
 * @param {{ simMs: number, observer: { lat: number, lon: number }, scratch?: Float32Array }} ctx
 * @returns {{ x: number, y: number, occluded: boolean } | null}
 */
export function objectScreenPosition(obj, positions, projection, view, ctx) {
  const group = String(obj.group ?? '');
  if (hasOrbit(group)) {
    const i = positions.index.get(obj.id);
    if (i === undefined) return null;
    return projectRecord(projection, positions.data, i * STRIDE, view);
  }
  const surface = SURFACE_FIELDS[group];
  if (surface) {
    const lat = obj.fields?.[surface.lat], lon = obj.fields?.[surface.lon];
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const rec = surfaceRecord(lat, lon, ctx.simMs, ctx.observer, ctx.scratch);
    return projectRecord(projection, rec, 0, view);
  }
  return viewCentre(view.width, view.height);
}

/**
 * Builds sprite instances for a `points`, `rings` or `glyph` layer.
 * @param {{
 *   layer: import('./layer-state.js').LayerState,
 *   objects: any[],
 *   positions: { ids: string[], data: Float32Array, index: Map<string, number> },
 *   projection: string,
 *   view: { width: number, height: number, cam?: any },
 *   ctx: { simMs: number, observer: { lat: number, lon: number }, scratch?: Float32Array },
 *   resolve: (objectId: string) => Record<string, number | string>,
 *   pixelRatio: number,
 *   nowMs: number,
 *   lastEventMs?: Map<string, number>,
 *   glyphIndex?: (ch: string) => number,
 * }} o
 * @returns {{ count: number, data: Float32Array, ids: string[] }}
 */
export function buildSprites(o) {
  const { layer, objects, positions, projection, view, ctx, resolve, pixelRatio, nowMs } = o;
  const data = new Float32Array(objects.length * SPRITE_STRIDE);
  const ids = [];
  let n = 0;
  for (const obj of objects) {
    const p = objectScreenPosition(obj, positions, projection, view, ctx);
    if (!p) continue;
    const props = resolve(obj.id);
    const rgb = parseHex(/** @type {string} */ (props.color)) ?? WHITE;
    let alpha = /** @type {number} */ (props.opacity);
    if (p.occluded) alpha *= OCCLUDED_ALPHA;
    let size = 0, width = 0, glyph = 0;
    if (layer.type === 'points') size = /** @type {number} */ (props.size) * pixelRatio;
    else if (layer.type === 'rings') { size = /** @type {number} */ (props.radius) * pixelRatio; width = /** @type {number} */ (props.width) * pixelRatio; }
    else if (layer.type === 'glyph') {
      size = /** @type {number} */ (props.size) * pixelRatio;
      glyph = o.glyphIndex ? o.glyphIndex(/** @type {string} */ (props.char)) : 0;
      const fade = /** @type {number} */ (props.fade);
      if (fade > 0) {
        const since = (nowMs - (o.lastEventMs?.get(obj.id) ?? nowMs)) / 1000;
        alpha *= Math.max(0, 1 - since / fade);
      }
    }
    if (!(alpha > 0)) continue;
    const k = n * SPRITE_STRIDE;
    data[k] = p.x; data[k + 1] = p.y; data[k + 2] = size; data[k + 3] = width;
    data[k + 4] = rgb[0]; data[k + 5] = rgb[1]; data[k + 6] = rgb[2]; data[k + 7] = alpha; data[k + 8] = glyph;
    ids.push(obj.id);
    n++;
  }
  return { count: n, data: data.subarray(0, n * SPRITE_STRIDE), ids };
}

/**
 * Builds segment instances from worker paths, for `lines` and `trail`.
 * @param {{
 *   paths: { ids: string[], steps: number, stepSec: number, fromSec: number, simMs?: number, data: Float32Array } | null,
 *   objects: any[],
 *   projection: string,
 *   view: { width: number, height: number, cam?: any },
 *   simNowMs: number,
 *   pathSimMs: number,
 *   window: (objectId: string) => { fromSec: number, toSec: number, color: string, opacity: number, fadeSec?: number } | null,
 *   head?: (objectId: string) => { x: number, y: number, occluded: boolean } | null,
 *   pixelRatio: number,
 * }} o
 * @returns {{ count: number, data: Float32Array }}
 */
export function buildSegments(o) {
  const { paths, objects, projection, view, simNowMs, pathSimMs, pixelRatio } = o;
  if (!paths || !paths.steps) return { count: 0, data: new Float32Array(0) };
  const byId = new Map(paths.ids.map((id, i) => [id, i]));
  const maxJump = projection === 'map' ? mapRect(view.width, view.height).w / 2 : Infinity;
  /** @type {number[]} */
  const out = [];
  for (const obj of objects) {
    const pi = byId.get(obj.id);
    if (pi === undefined) continue;
    const w = o.window(obj.id);
    if (!w || !(w.opacity > 0)) continue;
    const rgb = parseHex(w.color) ?? WHITE;
    let prev = null, prevAge = 0;
    for (let k = 0; k < paths.steps; k++) {
      // Offset of this sample from the current simulated time, in seconds.
      const off = (pathSimMs - simNowMs) / 1000 + paths.fromSec + k * paths.stepSec;
      if (off < w.fromSec || off > w.toSec) { prev = null; continue; }
      const p = projectRecord(projection, paths.data, (pi * paths.steps + k) * STRIDE, view);
      if (p && prev) pushSegment(out, prev, p, rgb, w, prevAge, -off, maxJump, pixelRatio);
      prev = p;
      prevAge = -off;
    }
    if (prev && o.head) {
      const h = o.head(obj.id);
      if (h) pushSegment(out, prev, h, rgb, w, prevAge, 0, maxJump, pixelRatio);
    }
  }
  return { count: out.length / SEGMENT_STRIDE, data: new Float32Array(out) };
}

/**
 * @param {number[]} out
 * @param {{ x: number, y: number, occluded: boolean }} a
 * @param {{ x: number, y: number, occluded: boolean }} b
 * @param {number[]} rgb
 * @param {{ opacity: number, fadeSec?: number }} w
 * @param {number} ageA seconds before now
 * @param {number} ageB
 * @param {number} maxJump
 * @param {number} pixelRatio
 */
function pushSegment(out, a, b, rgb, w, ageA, ageB, maxJump, pixelRatio) {
  if (Math.abs(b.x - a.x) > maxJump) return;
  let alpha = w.opacity;
  if (w.fadeSec && w.fadeSec > 0) alpha *= Math.max(0, 1 - Math.max(0, (ageA + ageB) / 2) / w.fadeSec);
  if (a.occluded || b.occluded) alpha *= OCCLUDED_ALPHA;
  if (!(alpha > 0)) return;
  out.push(a.x, a.y, b.x, b.y, PATH_WIDTH * pixelRatio, rgb[0], rgb[1], rgb[2], alpha);
}

/**
 * Largest value of a numeric property over a layer's objects, rounded up to
 * `quantum`, so path requests change rarely.
 * @param {any[]} objects @param {(id: string) => Record<string, any>} resolve @param {string} prop @param {number} quantum
 */
export function maxProp(objects, resolve, prop, quantum) {
  let m = 0;
  for (const o of objects) {
    const v = resolve(o.id)[prop];
    if (typeof v === 'number' && v > m) m = v;
  }
  return m > 0 ? Math.ceil(m / quantum) * quantum : 0;
}

/**
 * Path request of a points layer's trails, for the longest trail `maxTrailSec` (from maxProp).
 * @param {string} key @param {string} group @param {number} maxTrailSec
 * @returns {import('./propagation-core.js').PathRequest}
 */
export function trailRequest(key, group, maxTrailSec) {
  return { key, group, fromSec: -(maxTrailSec + TRAIL_MARGIN_SEC), toSec: 0, stepSec: Math.max(MIN_TRAIL_STEP_SEC, maxTrailSec / TRAIL_SAMPLES) };
}

/**
 * Path request of a lines layer, for the longest `span` in minutes (from maxProp): half before and half after now.
 * @param {string} key @param {string} group @param {number} maxSpanMin
 * @returns {import('./propagation-core.js').PathRequest}
 */
export function linesRequest(key, group, maxSpanMin) {
  const half = (maxSpanMin * 60) / 2;
  return { key, group, fromSec: -half, toSec: half, stepSec: LINE_STEP_SEC };
}
