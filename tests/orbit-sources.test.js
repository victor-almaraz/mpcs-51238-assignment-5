import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  degreesToRadians, ecfToLookAngles, eciToEcf, eciToGeodetic, gstime, json2satrec, propagate,
} from 'satellite.js';
import {
  EARTH_RADIUS_KM, ORBIT_QUANTITIES, createOrbit, isSunlit, lookAngles, orbitValue, periodMinutes, propagateAt, scaledTime,
} from '../src/sky/orbit.js';
import { createReplay } from '../src/sky/replay.js';
import { createFakeClock } from './fakes/fake-clock.js';
import { createFakeSupabase } from './fakes/fake-supabase.js';

const ISS = JSON.parse(readFileSync(new URL('./fixtures/sky/iss-object.json', import.meta.url), 'utf8'));
const OMM = JSON.parse(readFileSync(new URL('./fixtures/sky/iss-omm.json', import.meta.url), 'utf8'));
const TIMES = ['2026-10-29T14:00:00Z', '2026-10-29T18:30:00Z', '2026-10-30T02:00:00Z'].map(Date.parse);
const CHICAGO = { lat: 41.79, lon: -87.6 };
const DEG = Math.PI / 180;

/** Reference values computed directly with satellite.js from the raw OMM record. */
function reference(ms) {
  const satrec = json2satrec(OMM);
  const date = new Date(ms);
  const { position: r, velocity: v } = propagate(satrec, date);
  const gmst = gstime(date);
  const gd = eciToGeodetic(r, gmst);
  const look = ecfToLookAngles(
    { latitude: degreesToRadians(CHICAGO.lat), longitude: degreesToRadians(CHICAGO.lon), height: 0 },
    eciToEcf(r, gmst),
  );
  // Argument of latitude from classical elements: ω + ν.
  const mu = 398600.8;
  const rn = Math.hypot(r.x, r.y, r.z);
  const vv = v.x * v.x + v.y * v.y + v.z * v.z;
  const rv = r.x * v.x + r.y * v.y + r.z * v.z;
  const ev = ['x', 'y', 'z'].map((k) => ((vv - mu / rn) * r[k] - rv * v[k]) / mu);
  const h = { x: r.y * v.z - r.z * v.y, y: r.z * v.x - r.x * v.z, z: r.x * v.y - r.y * v.x };
  const n = [-h.y, h.x, 0];
  const nn = Math.hypot(...n);
  const en = Math.hypot(...ev);
  let argp = Math.acos((n[0] * ev[0] + n[1] * ev[1]) / (nn * en));
  if (ev[2] < 0) argp = 2 * Math.PI - argp;
  let nu = Math.acos((ev[0] * r.x + ev[1] * r.y + ev[2] * r.z) / (en * rn));
  if (rv < 0) nu = 2 * Math.PI - nu;
  const u = argp + nu;
  return {
    latitude: gd.latitude / DEG / OMM.INCLINATION,
    longitude: gd.longitude / DEG / 180,
    altitude: (2 * (rn - EARTH_RADIUS_KM - satrec.altp * EARTH_RADIUS_KM)) / ((satrec.alta - satrec.altp) * EARTH_RADIUS_KM) - 1,
    phaseSin: Math.sin(u),
    phaseCos: Math.cos(u),
    elevation: look.elevation / DEG / 90,
  };
}

test('quantities match satellite.js reference values at fixed times', () => {
  const orb = createOrbit(ISS.fields);
  for (const t of TIMES) {
    const s = orb.sample(t, CHICAGO);
    assert.equal(s.ok, true);
    const ref = reference(t);
    for (const q of ['latitude', 'longitude', 'phaseSin', 'phaseCos', 'elevation']) {
      assert.ok(Math.abs(s.values[q] - ref[q]) < 1e-6, `${q} at ${new Date(t).toISOString()}: ${s.values[q]} vs ${ref[q]}`);
    }
    const refAlt = Math.max(-1, Math.min(1, ref.altitude));
    assert.ok(Math.abs(s.values.altitude - refAlt) < 1e-6, `altitude ${s.values.altitude} vs ${refAlt}`);
    for (const q of ORBIT_QUANTITIES) {
      assert.ok(s.values[q] >= -1 && s.values[q] <= 1, `${q} in range`);
      assert.equal(orbitValue(orb, q, t, CHICAGO), s.values[q]);
    }
  }
});

test('elevation is null without an observer; unknown quantity throws', () => {
  const orb = createOrbit(ISS.fields);
  assert.equal(orbitValue(orb, 'elevation', TIMES[0]), null);
  assert.throws(() => orbitValue(orb, 'azimuth', TIMES[0]), /unknown orbit quantity/);
});

/** Meeus, Astronomical Algorithms ch. 25 (low accuracy), as an independent solar reference. */
function meeusSun(ms) {
  const jd = ms / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * DEG;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  const lon = (L0 + C) * DEG;
  const eps = (23.439291 - 0.0130042 * T) * DEG;
  return { x: Math.cos(lon), y: Math.cos(eps) * Math.sin(lon), z: Math.sin(eps) * Math.sin(lon) };
}

test('sunlit switches at shadow entry and exit within 10 s of a reference', () => {
  const orb = createOrbit(ISS.fields);
  const start = TIMES[0];
  const ours = [];
  const refs = [];
  let prevOurs = null;
  let prevRef = null;
  for (let s = 0; s <= 2 * 93 * 60; s++) {
    const t = start + s * 1000;
    const sample = orb.sample(t);
    const o = sample.values.sunlit;
    const r = isSunlit(sample.eci, meeusSun(t)) ? 1 : -1;
    if (prevOurs !== null && o !== prevOurs) ours.push({ t, to: o });
    if (prevRef !== null && r !== prevRef) refs.push({ t, to: r });
    prevOurs = o;
    prevRef = r;
  }
  assert.ok(refs.length >= 2, 'two orbits include shadow entries and exits');
  assert.equal(ours.length, refs.length);
  ours.forEach((x, i) => {
    assert.equal(x.to, refs[i].to);
    assert.ok(Math.abs(x.t - refs[i].t) <= 10000, `switch ${i} differs by ${(x.t - refs[i].t) / 1000} s`);
  });
  assert.ok(refs.some((x) => x.to === -1) && refs.some((x) => x.to === 1));
});

test('period equals 1440 / meanMotion minutes within 0.5%', () => {
  const orb = createOrbit(ISS.fields);
  assert.equal(orb.periodMin, 1440 / ISS.fields.meanMotion);
  assert.equal(periodMinutes(ISS.fields), orb.periodMin);
  assert.equal(periodMinutes({ meanMotion: null }), null);
  // Ascending node crossings: phaseSin from negative to non-negative.
  const crossings = [];
  let prev = null;
  const start = TIMES[0];
  for (let s = 0; s <= 4 * 93 * 60; s += 5) {
    const t = start + s * 1000;
    const v = orb.sample(t).values.phaseSin;
    if (prev !== null && prev.v < 0 && v >= 0) crossings.push(prev.t + ((t - prev.t) * -prev.v) / (v - prev.v));
    prev = { t, v };
  }
  assert.ok(crossings.length >= 3);
  const measuredMin = (crossings.at(-1) - crossings[0]) / (crossings.length - 1) / 60000;
  assert.ok(Math.abs(measuredMin / orb.periodMin - 1) < 0.005, `measured ${measuredMin} min vs ${orb.periodMin}`);
});

/** Unwrapped argument-of-latitude advance between two times. */
function phaseAdvance(orb, t0, t1) {
  const a = orb.sample(t0).values;
  const b = orb.sample(t1).values;
  let d = Math.atan2(b.phaseSin, b.phaseCos) - Math.atan2(a.phaseSin, a.phaseCos);
  while (d < 0) d += 2 * Math.PI;
  return d;
}

test('timeScale multiplies phase advance', () => {
  const orb = createOrbit(ISS.fields);
  const t0 = TIMES[0];
  const t = t0 + 30000;
  assert.equal(scaledTime(t, t0, 1), t);
  assert.equal(scaledTime(t, t0, 10), t0 + 300000);
  const real = phaseAdvance(orb, t0, t);
  const scaled = phaseAdvance(orb, t0, scaledTime(t, t0, 10));
  assert.ok(Math.abs(scaled / real - 10) < 0.05, `ratio ${scaled / real}`);
  assert.throws(() => scaledTime(t, t0, 0.5), /timeScale/);
  assert.throws(() => scaledTime(t, t0, 1001), /timeScale/);
});

test('replay clock drives propagation', async () => {
  const from = TIMES[0];
  const clock = createFakeClock(from + 3 * 86400000);
  const fake = createFakeSupabase({
    tables: {
      sky_objects: [{
        id: ISS.id, source: ISS.source, group_key: ISS.group, fields: ISS.fields, hash: 'h',
        trace_id: '11111111-1111-4111-8111-111111111111', updated_at: '2026-10-29T13:40:00Z', removed_at: null,
      }],
    },
  });
  const sky = createReplay({ client: fake.client, from, to: from + 3600000, speed: 100, now: clock.now, timers: clock.timers, trace: () => {} });
  await sky.follow(['celestrak.stations']);
  assert.equal(sky.now(), from);
  await clock.advance(1000);
  assert.equal(sky.now(), from + 100000);
  const orb = createOrbit(sky.object(ISS.id).fields);
  assert.deepEqual(orb.sample(sky.now()).values, createOrbit(ISS.fields).sample(from + 100000).values);
  sky.close();
});

test('propagation failure returns the satrec error code', () => {
  const decayed = createOrbit({ ...ISS.fields, meanMotion: 17.5, bstar: 0.5 });
  const d = decayed.sample(TIMES[0] + 30 * 86400000);
  assert.equal(d.ok, false);
  assert.ok(d.error > 0);
});

test('propagateAt is the SGP4 step of sample: same position, geodetic point and look angles as satellite.js', () => {
  const orb = createOrbit(ISS.fields);
  for (const ms of TIMES) {
    const st = propagateAt(orb.satrec, ms);
    assert.ok(st.ok);
    const date = new Date(ms);
    const ref = propagate(json2satrec(OMM), date);
    const gmst = gstime(date);
    assert.ok(Math.abs(st.eci.x - ref.position.x) < 1e-6);
    assert.ok(Math.abs(st.gmst - gmst) < 1e-12);
    const geo = eciToGeodetic(ref.position, gmst);
    assert.ok(Math.abs(st.geodetic.latitude - geo.latitude) < 1e-9);
    const look = ecfToLookAngles({ latitude: degreesToRadians(CHICAGO.lat), longitude: degreesToRadians(CHICAGO.lon), height: 0 }, eciToEcf(ref.position, gmst));
    const mine = lookAngles(CHICAGO, st.eci, st.gmst);
    assert.ok(Math.abs(mine.elevation - look.elevation) < 1e-9);
    assert.ok(Math.abs(mine.azimuth - look.azimuth) < 1e-9);
    const sample = orb.sample(ms, CHICAGO);
    assert.ok(sample.ok);
    assert.deepEqual(sample.eci, st.eci);
  }
});

test('propagateAt reports failure instead of throwing', () => {
  const decayed = createOrbit({ ...ISS.fields, eccentricity: 1.5 });
  const st = propagateAt(decayed.satrec, TIMES[0]);
  assert.equal(st.ok, false);
  assert.equal(typeof (/** @type {any} */ (st)).error, 'number');
  assert.deepEqual(propagateAt({ ...decayed.satrec, jdsatepoch: NaN }, TIMES[0]).ok, false);
});
