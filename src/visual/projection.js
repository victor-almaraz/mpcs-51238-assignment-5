/**
 * Projection math for the three views (doc/visuals.md, Projections).
 * Screen coordinates are device pixels with the origin at the top left.
 */
import { gstime, geodeticToEcf, ecfToEci, ecfToLookAngles } from 'satellite.js';
import { EARTH_RADIUS_KM } from '../sky/orbit.js';
import { STRIDE } from './propagation-core.js';

export const PROJECTIONS = Object.freeze(['orbital', 'map', 'sky']);
export const CAMERA_ELEVATION_DEG = 20;
export const CAMERA_FOV_DEG = 35;
/** Seconds per camera turn in `orbital`. */
export const CAMERA_TURN_SEC = 600;
export const MIN_FIT_RADII = 1.6;
const DEG = Math.PI / 180;

/**
 * @typedef {{ pos: number[], right: number[], up: number[], fwd: number[], focal: number, width: number, height: number, dist: number }} Camera
 */

/**
 * @param {{ width: number, height: number, fitRadiusKm: number, azimuthRad?: number, elevationRad?: number, fovDeg?: number }} o
 * @returns {Camera}
 */
export function orbitalCamera({ width, height, fitRadiusKm, azimuthRad = 0, elevationRad = CAMERA_ELEVATION_DEG * DEG, fovDeg = CAMERA_FOV_DEG }) {
  const half = (fovDeg * DEG) / 2;
  const dist = Math.max(fitRadiusKm, EARTH_RADIUS_KM) / Math.sin(half);
  const ce = Math.cos(elevationRad);
  const pos = [dist * ce * Math.cos(azimuthRad), dist * ce * Math.sin(azimuthRad), dist * Math.sin(elevationRad)];
  const fwd = scale(pos, -1 / dist);
  const right = normalize(cross(fwd, [0, 0, 1]));
  const up = cross(right, fwd);
  const focal = Math.min(width, height) / 2 / Math.tan(half);
  return { pos, right, up, fwd, focal, width, height, dist };
}

/**
 * Projects an ECI point (km). Returns null behind the camera.
 * @param {Camera} cam @param {number} x @param {number} y @param {number} z
 * @returns {{ x: number, y: number, depth: number, occluded: boolean } | null}
 */
export function projectOrbital(cam, x, y, z) {
  const rx = x - cam.pos[0], ry = y - cam.pos[1], rz = z - cam.pos[2];
  const zc = rx * cam.fwd[0] + ry * cam.fwd[1] + rz * cam.fwd[2];
  if (zc <= 1e-6) return null;
  const xc = rx * cam.right[0] + ry * cam.right[1] + rz * cam.right[2];
  const yc = rx * cam.up[0] + ry * cam.up[1] + rz * cam.up[2];
  return {
    x: cam.width / 2 + (cam.focal * xc) / zc,
    y: cam.height / 2 - (cam.focal * yc) / zc,
    depth: zc,
    occluded: occludedByEarth(cam.pos, [x, y, z]),
  };
}

/**
 * True when the segment from the camera to `p` passes through Earth first.
 * @param {number[]} o camera position @param {number[]} p point
 */
export function occludedByEarth(o, p) {
  const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  const L = Math.hypot(d[0], d[1], d[2]);
  if (L === 0) return false;
  const u = scale(d, 1 / L);
  const b = o[0] * u[0] + o[1] * u[1] + o[2] * u[2];
  const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - EARTH_RADIUS_KM * EARTH_RADIUS_KM;
  const disc = b * b - c;
  if (disc <= 0) return false;
  const t1 = -b - Math.sqrt(disc);
  return t1 > 0 && t1 < L - 1e-3;
}

/** Screen disc of Earth's silhouette. @param {Camera} cam */
export function earthDisc(cam) {
  const alpha = Math.asin(Math.min(1, EARTH_RADIUS_KM / cam.dist));
  return { x: cam.width / 2, y: cam.height / 2, r: cam.focal * Math.tan(alpha) };
}

/**
 * Map rectangle letterboxed at 2:1.
 * @param {number} w @param {number} h
 */
export function mapRect(w, h) {
  const mw = Math.min(w, 2 * h);
  const mh = mw / 2;
  return { x: (w - mw) / 2, y: (h - mh) / 2, w: mw, h: mh };
}

/**
 * @param {number} latRad @param {number} lonRad @param {number} w @param {number} h
 * @returns {{ x: number, y: number }}
 */
export function projectMap(latRad, lonRad, w, h) {
  const r = mapRect(w, h);
  return { x: r.x + ((lonRad / Math.PI + 1) / 2) * r.w, y: r.y + (0.5 - latRad / Math.PI) * r.h };
}

/** Radius of the horizon circle in `sky`. @param {number} w @param {number} h */
export function skyRadius(w, h) {
  return 0.95 * (Math.min(w, h) / 2);
}

/**
 * Azimuthal equidistant projection around the zenith; north up, east left.
 * Returns null below the horizon.
 * @param {number} azRad @param {number} elRad @param {number} w @param {number} h
 * @returns {{ x: number, y: number } | null}
 */
export function projectSky(azRad, elRad, w, h) {
  if (!(elRad >= 0)) return null;
  const rho = ((Math.PI / 2 - elRad) / (Math.PI / 2)) * skyRadius(w, h);
  return { x: w / 2 - rho * Math.sin(azRad), y: h / 2 - rho * Math.cos(azRad) };
}

/**
 * Projects one position record (`STRIDE` floats at `offset`).
 * @param {string} projection
 * @param {ArrayLike<number>} rec
 * @param {number} offset
 * @param {{ width: number, height: number, cam?: Camera }} view
 * @returns {{ x: number, y: number, occluded: boolean } | null}
 */
export function projectRecord(projection, rec, offset, view) {
  if (Number.isNaN(rec[offset])) return null;
  if (projection === 'orbital') {
    if (!view.cam) return null;
    return projectOrbital(view.cam, rec[offset], rec[offset + 1], rec[offset + 2]);
  }
  if (projection === 'map') {
    const p = projectMap(rec[offset + 3], rec[offset + 4], view.width, view.height);
    return { x: p.x, y: p.y, occluded: false };
  }
  const p = projectSky(rec[offset + 6], rec[offset + 7], view.width, view.height);
  return p ? { x: p.x, y: p.y, occluded: false } : null;
}

/** The centre of the view, used for groups without positions. @param {number} w @param {number} h */
export function viewCentre(w, h) {
  return { x: w / 2, y: h / 2, occluded: false };
}

/**
 * Position record of a point on Earth's surface (a launch pad).
 * @param {number} latDeg @param {number} lonDeg @param {number} simMs
 * @param {{ lat: number, lon: number }} observer degrees
 * @param {Float32Array} [out] @param {number} [offset]
 */
export function surfaceRecord(latDeg, lonDeg, simMs, observer, out = new Float32Array(STRIDE), offset = 0) {
  const gd = { latitude: latDeg * DEG, longitude: lonDeg * DEG, height: 0 };
  const ecf = geodeticToEcf(gd);
  const eci = ecfToEci(ecf, gstime(new Date(simMs)));
  const look = ecfToLookAngles({ latitude: observer.lat * DEG, longitude: observer.lon * DEG, height: 0 }, ecf);
  out[offset] = eci.x; out[offset + 1] = eci.y; out[offset + 2] = eci.z;
  out[offset + 3] = gd.latitude; out[offset + 4] = gd.longitude; out[offset + 5] = 0;
  out[offset + 6] = look.azimuth; out[offset + 7] = look.elevation;
  return out;
}

/**
 * Radius the orbital camera frames: 1.1 × the largest radius of the
 * records, at least `MIN_FIT_RADII` Earth radii.
 * @param {ArrayLike<number>} data @param {number} [stride]
 */
export function fitRadiusKm(data, stride = STRIDE) {
  let max = 0;
  for (let i = 0; i + 2 < data.length; i += stride) {
    const r = Math.hypot(data[i], data[i + 1], data[i + 2]);
    if (Number.isFinite(r) && r > max) max = r;
  }
  return Math.max(MIN_FIT_RADII * EARTH_RADIUS_KM, 1.1 * max);
}

/** Camera azimuth at time `ms` since start; 0 under reduced motion. @param {number} elapsedMs @param {boolean} reducedMotion */
export function cameraAzimuth(elapsedMs, reducedMotion) {
  return reducedMotion ? 0 : ((elapsedMs / 1000 / CAMERA_TURN_SEC) % 1) * 2 * Math.PI;
}

/** @param {number[]} a @param {number[]} b */
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
/** @param {number[]} a @param {number} s */
function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}
/** @param {number[]} a */
function normalize(a) {
  const n = Math.hypot(a[0], a[1], a[2]);
  return scale(a, 1 / n);
}
