// Ground tracks for the landing page's orbit map (doc/ui.md, Landing).
import { degreesLat, degreesLong, eciToGeodetic, gstime, json2satrec, propagate } from 'satellite.js';
import { toOmm } from '../sky/omm.js';
import { sunDirection } from '../sky/orbit.js';

export const STEP_MS = 2000;
export const TRAIL_MINUTES = 45;

/** satrecs for objects whose elements convert; failed objects are omitted. */
export function satrecs(objects) {
  const out = [];
  for (const o of objects) {
    try {
      out.push({ id: o.id, name: String(o.fields.name ?? o.id), satrec: json2satrec(toOmm(o.fields)) });
    } catch {
      // omitted: invalid elements
    }
  }
  return out;
}

/** { lat, lon } in degrees, or null when propagation fails. */
export function subPoint(satrec, date) {
  const pv = propagate(satrec, date);
  if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
  const g = eciToGeodetic(pv.position, gstime(date));
  const lat = degreesLat(g.latitude);
  const lon = degreesLong(g.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/** Past positions, oldest first, one per minute. */
export function trail(satrec, date, minutes = TRAIL_MINUTES) {
  const pts = [];
  for (let m = minutes; m >= 0; m--) {
    const p = subPoint(satrec, new Date(date.getTime() - m * 60_000));
    if (p) pts.push(p);
  }
  return pts;
}

/** Split a track where it crosses the antimeridian so lines do not span the map. */
export function splitAtAntimeridian(points) {
  const runs = [];
  let run = [];
  for (const p of points) {
    if (run.length && Math.abs(p.lon - run.at(-1).lon) > 180) {
      runs.push(run);
      run = [];
    }
    run.push(p);
  }
  if (run.length) runs.push(run);
  return runs;
}

const DEG = Math.PI / 180;

/** Subsolar point in degrees, from the sky module's solar direction and Greenwich sidereal time. */
export function subsolarPoint(date) {
  const sun = sunDirection(date.getTime());
  let lon = (Math.atan2(sun.y, sun.x) - gstime(date)) / DEG;
  lon = ((lon + 540) % 360) - 180;
  return { lat: Math.asin(sun.z) / DEG, lon };
}

/** Cosine of the solar zenith angle at a point; negative on the night side. */
export function sunCos(lat, lon, sun) {
  return Math.sin(lat * DEG) * Math.sin(sun.lat * DEG)
    + Math.cos(lat * DEG) * Math.cos(sun.lat * DEG) * Math.cos((lon - sun.lon) * DEG);
}

/**
 * Latitude of the terminator (solar altitude 0) at a longitude, and the pole on the night side of
 * it. A declination within 0.1° of the equator is treated as 0.1° so the curve stays finite.
 */
export function terminator(lon, sun) {
  const decl = Math.sign(sun.lat || 1) * Math.max(Math.abs(sun.lat), 0.1);
  return { lat: Math.atan(-Math.cos((lon - sun.lon) * DEG) / Math.tan(decl * DEG)) / DEG, nightPole: decl > 0 ? -90 : 90 };
}

/** Equirectangular map position in pixels. */
export function toMap(lat, lon, w, h) {
  return { x: ((lon + 180) / 360) * w, y: ((90 - lat) / 180) * h };
}
