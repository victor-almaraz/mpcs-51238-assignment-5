import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { json2satrec, propagate, gstime, eciToGeodetic } from 'satellite.js';
import { toOmm } from '../src/sky/omm.js';
import { createPropagationCore, STRIDE, LEAD_MS, orbitKey, simTime } from '../src/visual/propagation-core.js';

const STATIONS = JSON.parse(readFileSync(new URL('./fixtures/visual/stations-objects.json', import.meta.url), 'utf8'));
const ISS = STATIONS.find((o) => o.id === 'celestrak.stations:25544');
const T0 = Date.parse('2026-10-29T14:00:00Z');

function core({ now = () => T0 } = {}) {
  const posts = [];
  const c = createPropagationCore({ post: (msg, transfer) => posts.push({ msg, transfer }), now });
  return { c, posts, samples: () => posts.filter((p) => p.msg.type === 'sample').map((p) => p.msg) };
}

const objects = (list) => ({ type: 'objects', objects: list.map((o) => ({ id: o.id, group: o.group, fields: o.fields, traceId: `t-${o.id}` })) });

test('positions match satellite.js for every station, including six-digit catalog numbers', () => {
  const { c, samples, posts } = core();
  c.handle({ type: 'clock', clock: { simMs: T0, wallMs: T0, speed: 1, t0SimMs: T0 } });
  c.handle(objects(STATIONS));
  c.handle({ type: 'tick' });
  const s = samples()[0];
  assert.equal(s.ids.length, STATIONS.length);
  assert.ok(s.ids.includes('celestrak.stations:101031'));
  assert.equal(s.positions.length, STATIONS.length * STRIDE);
  assert.equal(s.simMs, T0 + LEAD_MS);
  assert.deepEqual(posts[0].transfer, [s.positions.buffer, s.orbitValues.buffer], 'arrays are transferred');
  for (const id of ['celestrak.stations:25544', 'celestrak.stations:101031']) {
    const o = STATIONS.find((x) => x.id === id);
    const i = s.ids.indexOf(id) * STRIDE;
    const date = new Date(T0 + LEAD_MS);
    const ref = propagate(json2satrec(/** @type {any} */ (toOmm(o.fields))), date).position;
    const geo = eciToGeodetic(ref, gstime(date));
    assert.ok(Math.abs(s.positions[i] - ref.x) < 0.01, `${id} x`);
    assert.ok(Math.abs(s.positions[i + 1] - ref.y) < 0.01);
    assert.ok(Math.abs(s.positions[i + 2] - ref.z) < 0.01);
    assert.ok(Math.abs(s.positions[i + 3] - geo.latitude) < 1e-6);
    assert.ok(Math.abs(s.positions[i + 4] - geo.longitude) < 1e-6);
    assert.ok(Math.abs(s.positions[i + 5] - geo.height) < 0.01);
    assert.ok(s.positions[i + 7] >= -Math.PI / 2 && s.positions[i + 7] <= Math.PI / 2);
  }
  // ids are sent only when they change
  c.handle({ type: 'tick' });
  assert.equal(samples()[1].ids, undefined);
  assert.equal(samples()[1].idsVersion, s.idsVersion);
});

test('a failed object is omitted and traced once per element set', () => {
  const { c, samples, posts } = core();
  const decayed = { id: 'celestrak.stations:99999', group: 'celestrak.stations', fields: { ...ISS.fields, noradId: '99999', eccentricity: 1.5 } };
  const broken = { id: 'celestrak.stations:99998', group: 'celestrak.stations', fields: { ...ISS.fields, noradId: '99998', meanMotion: null } };
  c.handle(objects([ISS, decayed, broken]));
  c.handle({ type: 'tick' });
  c.handle({ type: 'tick' });
  const s = samples()[1];
  const ids = samples()[0].ids;
  const at = (id) => ids.indexOf(id) * STRIDE;
  assert.ok(Number.isFinite(s.positions[at(ISS.id)]));
  assert.ok(Number.isNaN(s.positions[at(decayed.id)]));
  assert.ok(Number.isNaN(s.positions[at(broken.id)]));
  const traces = posts.filter((p) => p.msg.type === 'trace').map((p) => p.msg.record);
  assert.equal(traces.length, 2, 'once per object');
  const d = traces.find((r) => r.data.objectId === decayed.id);
  assert.equal(d.stage, 'VISUAL');
  assert.equal(d.component, 'sgp4');
  assert.equal(d.event, 'propagationFailed');
  assert.equal(d.data.code, 1);
  assert.equal(d.traceId, `t-${decayed.id}`);
  const b = traces.find((r) => r.data.objectId === broken.id);
  assert.match(b.data.message, /meanMotion/);
  // A new element set for the object is reported again.
  c.handle(objects([ISS, { ...decayed, fields: { ...decayed.fields, eccentricity: 1.2 } }]));
  c.handle({ type: 'tick' });
  assert.equal(posts.filter((p) => p.msg.type === 'trace').length, 3);
});

test('unchanged element sets keep their satrec; ids follow the object set', () => {
  const { c, samples } = core();
  c.handle(objects(STATIONS.slice(0, 3)));
  c.handle({ type: 'tick' });
  const v0 = samples()[0].idsVersion;
  c.handle(objects(STATIONS.slice(0, 3)));
  c.handle({ type: 'tick' });
  assert.equal(samples()[1].idsVersion, v0);
  c.handle(objects(STATIONS.slice(0, 2)));
  c.handle({ type: 'tick' });
  assert.equal(samples()[2].ids.length, 2);
  assert.ok(samples()[2].idsVersion > v0);
});

/**
 * Unwrapped argument-of-latitude phase over wall time, from the posted
 * phaseSin and phaseCos values of one object at one time scale.
 */
function phaseSeries(c, samples, id, ts, from, to, stepMs, setNow) {
  c.handle({ type: 'orbitSources', sources: [{ objectId: id, quantity: 'phaseSin', timeScale: ts }, { objectId: id, quantity: 'phaseCos', timeScale: ts }] });
  const out = [];
  let keys = null, prev = null, acc = 0;
  for (let t = from; t <= to; t += stepMs) {
    setNow(t);
    c.handle({ type: 'tick' });
    const s = samples().at(-1);
    keys = s.orbitKeys ?? keys;
    const ph = Math.atan2(s.orbitValues[keys.indexOf(orbitKey(id, 'phaseSin', ts))], s.orbitValues[keys.indexOf(orbitKey(id, 'phaseCos', ts))]);
    if (prev !== null) {
      let d = ph - prev;
      if (d < -Math.PI) d += 2 * Math.PI;
      if (d > Math.PI) d -= 2 * Math.PI;
      acc += d;
    }
    prev = ph;
    out.push([t, acc]);
  }
  return out;
}

/** A core with the ISS and a live clock starting at T0. */
function issCore() {
  const state = { now: T0 };
  const x = core({ now: () => state.now });
  x.c.handle({ type: 'clock', clock: { simMs: T0, wallMs: T0, speed: 1, t0SimMs: T0 } });
  x.c.handle(objects([ISS]));
  return { ...x, setNow: (t) => { state.now = t; } };
}

test('the phase period equals 1440 / meanMotion minutes within 0.5%', () => {
  const { c, samples, setNow } = issCore();
  const series = phaseSeries(c, samples, ISS.id, 1, T0, T0 + 3 * 3600e3, 30e3, setNow);
  const [t1, a1] = series.at(-1);
  const periodMin = ((t1 - T0) / 60000) * ((2 * Math.PI) / a1);
  const expected = 1440 / ISS.fields.meanMotion;
  assert.ok(Math.abs(periodMin - expected) / expected < 0.005, `period ${periodMin.toFixed(2)} min vs ${expected.toFixed(2)} min`);
});

test('timeScale multiplies phase advance', () => {
  const a = issCore();
  const scaled = phaseSeries(a.c, a.samples, ISS.id, 10, T0, T0 + 600e3, 5e3, a.setNow).at(-1)[1];
  const b = issCore();
  const real = phaseSeries(b.c, b.samples, ISS.id, 1, T0, T0 + 6000e3, 50e3, b.setNow).at(-1)[1];
  // 600 s at ×10 covers the phase of 6000 s at ×1 (the 500 ms lead adds 5 s at ×10).
  assert.ok(Math.abs(scaled - real) / real < 0.01, `scaled ${scaled} vs real ${real}`);
});

test('the replay clock drives propagation at the replay speed', () => {
  const from = Date.parse('2026-10-28T00:00:00Z');
  let now = T0;
  const { c, samples } = core({ now: () => now });
  c.handle(objects([ISS]));
  c.handle({ type: 'clock', clock: { simMs: from, wallMs: T0, speed: 100, t0SimMs: from } });
  now = T0 + 10_000;
  c.handle({ type: 'tick' });
  const s = samples().at(-1);
  assert.equal(s.simMs, from + (10_000 + LEAD_MS) * 100);
  assert.equal(simTime({ simMs: from, wallMs: T0, speed: 100, t0SimMs: from }, T0 + 1000), from + 100_000);
  const ref = propagate(json2satrec(/** @type {any} */ (toOmm(ISS.fields))), new Date(s.simMs)).position;
  assert.ok(Math.abs(s.positions[0] - ref.x) < 0.01);
});

test('orbit sources with a null object cover every object of the group; values are −1 to 1', () => {
  const { c, samples } = core();
  c.handle(objects(STATIONS));
  c.handle({ type: 'observer', observer: { lat: 41.79, lon: -87.6 } });
  c.handle({ type: 'orbitSources', sources: [
    { objectId: null, group: 'celestrak.stations', quantity: 'latitude', timeScale: 1 },
    { objectId: ISS.id, quantity: 'elevation' },
    { objectId: ISS.id, quantity: 'bogus' },
  ] });
  c.handle({ type: 'tick' });
  const s = samples().at(-1);
  assert.equal(s.orbitKeys.length, STATIONS.length + 1);
  assert.ok(s.orbitKeys.includes(orbitKey(ISS.id, 'elevation', 1)));
  for (const v of s.orbitValues) assert.ok(v >= -1 && v <= 1);
});

test('paths are sampled for requests and sent with their sim time', () => {
  const { c, posts } = core();
  c.handle(objects(STATIONS.slice(0, 2)));
  c.handle({ type: 'paths', requests: [{ key: 'lines:l0', group: 'celestrak.stations', fromSec: -2700, toSec: 2700, stepSec: 60 }, { key: 'bad', group: 'x', fromSec: 1, toSec: 0, stepSec: 1 }] });
  c.handle({ type: 'tick' });
  c.handle({ type: 'tick' });
  const paths = posts.filter((p) => p.msg.type === 'paths').map((p) => p.msg);
  assert.equal(paths.length, 1, 'computed once per 5 s, invalid requests dropped');
  assert.equal(paths[0].steps, 91);
  assert.equal(paths[0].ids.length, 2);
  assert.equal(paths[0].data.length, 2 * 91 * STRIDE);
  assert.equal(paths[0].simMs, T0 + LEAD_MS);
  // The middle sample of the path is the object's position now.
  const mid = 45 * STRIDE;
  const ref = propagate(json2satrec(/** @type {any} */ (toOmm(STATIONS.slice(0, 2).sort((a, b) => a.id.localeCompare(b.id))[0].fields))), new Date(T0 + LEAD_MS)).position;
  assert.ok(Math.abs(paths[0].data[mid] - ref.x) < 0.01);
});
