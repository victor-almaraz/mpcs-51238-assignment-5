// Orbit sources: VLFO quantities from an object's orbital elements
// (doc/piece-dsl.md, Orbits; doc/sky-contract.md, Orbit sources).
import {
  constants,
  degreesToRadians,
  ecfToLookAngles,
  eciToEcf,
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
} from 'satellite.js';
import { toOmm } from './omm.js';

export const ORBIT_QUANTITIES = Object.freeze([
  'latitude', 'phaseSin', 'phaseCos', 'altitude', 'longitude', 'sunlit', 'elevation',
]);

/** Earth equatorial radius used by SGP4 (WGS 72), km. */
export const EARTH_RADIUS_KM = constants.earthRadius;

const DEG = Math.PI / 180;
const MS_PER_DAY = 86400000;
const JD_UNIX_EPOCH = 2440587.5;
const JD_J2000 = 2451545.0;

/**
 * @typedef {{ x: number, y: number, z: number }} Vec3
 * @typedef {{ lat: number, lon: number }} Observer   degrees
 * @typedef {{ latitude: number, phaseSin: number, phaseCos: number, altitude: number,
 *             longitude: number, sunlit: number, elevation: number | null }} OrbitValues
 * @typedef {{ ok: true, values: OrbitValues, eci: Vec3,
 *             geodetic: { latDeg: number, lonDeg: number, heightKm: number } }
 *         | { ok: false, error: number }} OrbitSample
 */

/**
 * Builds a propagator for one celestrak.* object.
 * @param {Record<string, number | string | boolean | null>} fields normalized fields
 * @throws {import('./omm.js').OmmError} when required elements are missing
 */
export function createOrbit(fields) {
  const satrec = json2satrec(/** @type {any} */ (toOmm(fields)));
  const meanMotion = /** @type {number} */ (fields.meanMotion);
  const inclDeg = satrec.inclo / DEG;
  const maxLatDeg = inclDeg <= 90 ? inclDeg : 180 - inclDeg;
  const perigeeKm = satrec.altp * EARTH_RADIUS_KM;
  const apogeeKm = satrec.alta * EARTH_RADIUS_KM;

  return {
    satrec,
    /** Orbital period, minutes. */
    periodMin: 1440 / meanMotion,
    perigeeKm,
    apogeeKm,
    /**
     * @param {number} ms propagation time, ms since epoch
     * @param {Observer} [observer]
     * @returns {OrbitSample}
     */
    sample(ms, observer) {
      const date = new Date(ms);
      const pv = propagate(satrec, date);
      const r = pv && pv.position;
      const v = pv && pv.velocity;
      if (!r || !v || !finite3(r) || !finite3(v)) return { ok: false, error: satrec.error || -1 };

      const gmst = gstime(date);
      const gd = eciToGeodetic(r, gmst);
      const latDeg = gd.latitude / DEG;
      const lonDeg = gd.longitude / DEG;

      const u = argumentOfLatitude(r, v);
      const radiusAlt = Math.hypot(r.x, r.y, r.z) - EARTH_RADIUS_KM;
      const span = apogeeKm - perigeeKm;

      /** @type {number | null} */
      let elevation = null;
      if (observer && Number.isFinite(observer.lat) && Number.isFinite(observer.lon)) {
        const look = ecfToLookAngles(
          { latitude: degreesToRadians(observer.lat), longitude: degreesToRadians(observer.lon), height: 0 },
          eciToEcf(r, gmst),
        );
        elevation = clamp1(look.elevation / DEG / 90);
      }

      return {
        ok: true,
        eci: r,
        geodetic: { latDeg, lonDeg, heightKm: gd.height },
        values: {
          latitude: maxLatDeg < 0.1 ? 0 : clamp1(latDeg / maxLatDeg),
          phaseSin: Math.sin(u),
          phaseCos: Math.cos(u),
          altitude: span < 1 ? 0 : clamp1((2 * (radiusAlt - perigeeKm)) / span - 1),
          longitude: clamp1(lonDeg / 180),
          sunlit: isSunlit(r, sunDirection(ms)) ? 1 : -1,
          elevation,
        },
      };
    },
  };
}

/**
 * One orbit quantity, or null when propagation fails.
 * @param {ReturnType<typeof createOrbit>} orbit
 * @param {string} quantity one of ORBIT_QUANTITIES
 * @param {number} ms
 * @param {Observer} [observer]
 * @returns {number | null}
 */
export function orbitValue(orbit, quantity, ms, observer) {
  if (!ORBIT_QUANTITIES.includes(quantity)) throw new RangeError(`unknown orbit quantity ${quantity}`);
  const s = orbit.sample(ms, observer);
  if (!s.ok) return null;
  const v = s.values[/** @type {keyof OrbitValues} */ (quantity)];
  return v === null || !Number.isFinite(v) ? null : v;
}

/**
 * Time-scaled propagation time: t0 + (ms − t0) · timeScale.
 * @param {number} ms @param {number} t0 @param {number} timeScale 1–1000
 */
export function scaledTime(ms, t0, timeScale) {
  if (!(timeScale >= 1 && timeScale <= 1000)) throw new RangeError(`timeScale must be 1–1000, got ${timeScale}`);
  return t0 + (ms - t0) * timeScale;
}

/**
 * Orbital period from mean motion, minutes.
 * @param {{ meanMotion?: unknown }} fields
 * @returns {number | null}
 */
export function periodMinutes(fields) {
  const n = fields.meanMotion;
  return typeof n === 'number' && n > 0 ? 1440 / n : null;
}

/**
 * Argument of latitude (radians) from an inertial position and velocity.
 * @param {Vec3} r @param {Vec3} v
 */
export function argumentOfLatitude(r, v) {
  const h = cross(r, v);
  const hn = Math.hypot(h.x, h.y, h.z);
  const w = { x: h.x / hn, y: h.y / hn, z: h.z / hn };
  // Ascending node direction: ẑ × h; the x axis when the orbit is equatorial.
  let n = { x: -h.y, y: h.x, z: 0 };
  const nn = Math.hypot(n.x, n.y);
  n = nn < 1e-9 * hn ? { x: 1, y: 0, z: 0 } : { x: n.x / nn, y: n.y / nn, z: 0 };
  const m = cross(w, n);
  return Math.atan2(dot(r, m), dot(r, n));
}

/**
 * Unit vector to the Sun in the equatorial inertial frame, from the
 * Astronomical Almanac low-precision formula (USNO, about 0.01°).
 * @param {number} ms
 * @returns {Vec3}
 */
export function sunDirection(ms) {
  const d = ms / MS_PER_DAY + JD_UNIX_EPOCH - JD_J2000;
  const g = (357.529 + 0.98560028 * d) * DEG;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const e = (23.439 - 0.00000036 * d) * DEG;
  return { x: Math.cos(L), y: Math.cos(e) * Math.sin(L), z: Math.sin(e) * Math.sin(L) };
}

/**
 * Cylindrical Earth-shadow test.
 * @param {Vec3} r satellite position, km
 * @param {Vec3} sun unit vector to the Sun
 */
export function isSunlit(r, sun) {
  const p = dot(r, sun);
  if (p >= 0) return true;
  return dot(r, r) - p * p >= EARTH_RADIUS_KM * EARTH_RADIUS_KM;
}

/** @param {Vec3} a @param {Vec3} b */
function cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
/** @param {Vec3} a @param {Vec3} b */
function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
/** @param {Vec3} a */
function finite3(a) {
  return Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
}
/** @param {number} x */
function clamp1(x) {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}
