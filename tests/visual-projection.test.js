import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orbitalCamera, projectOrbital, occludedByEarth, earthDisc, projectMap, mapRect, projectSky, skyRadius,
  projectRecord, surfaceRecord, fitRadiusKm, cameraAzimuth, CAMERA_TURN_SEC,
} from '../src/visual/projection.js';
import { EARTH_RADIUS_KM } from '../src/sky/orbit.js';

const DEG = Math.PI / 180;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('map: equirectangular, letterboxed at 2:1', () => {
  assert.deepEqual(mapRect(1000, 300), { x: 200, y: 0, w: 600, h: 300 });
  assert.deepEqual(mapRect(800, 800), { x: 0, y: 200, w: 800, h: 400 });
  const w = 800, h = 400;
  assert.deepEqual(projectMap(0, 0, w, h), { x: 400, y: 200 });
  assert.deepEqual(projectMap(90 * DEG, -180 * DEG, w, h), { x: 0, y: 0 });
  assert.deepEqual(projectMap(-90 * DEG, 180 * DEG, w, h), { x: 800, y: 400 });
  const chicago = projectMap(41.79 * DEG, -87.6 * DEG, w, h);
  assert.ok(near(chicago.x, ((-87.6 + 180) / 360) * 800, 1e-9));
  assert.ok(near(chicago.y, ((90 - 41.79) / 180) * 400, 1e-9));
});

test('sky: zenith at the centre, north up, east left, below the horizon hidden', () => {
  const w = 600, h = 400, R = skyRadius(w, h);
  assert.equal(R, 190);
  assert.deepEqual(projectSky(0, 90 * DEG, w, h), { x: 300, y: 200 });
  const north = /** @type {any} */ (projectSky(0, 0, w, h));
  assert.ok(near(north.x, 300) && near(north.y, 200 - R));
  const east = /** @type {any} */ (projectSky(90 * DEG, 0, w, h));
  assert.ok(near(east.x, 300 - R) && near(east.y, 200));
  const half = /** @type {any} */ (projectSky(180 * DEG, 45 * DEG, w, h));
  assert.ok(near(half.y, 200 + R / 2));
  assert.equal(projectSky(0, -0.01, w, h), null);
});

test('orbital: Earth centre at the canvas centre; objects behind Earth are occluded', () => {
  const cam = orbitalCamera({ width: 800, height: 600, fitRadiusKm: 2 * EARTH_RADIUS_KM, azimuthRad: 0 });
  const c = /** @type {any} */ (projectOrbital(cam, 0, 0, 0));
  assert.ok(near(c.x, 400) && near(c.y, 300));
  // Camera sits at +x (azimuth 0), 20° above the equator.
  assert.ok(cam.pos[0] > 0 && near(cam.pos[1], 0) && cam.pos[2] > 0);
  const front = /** @type {any} */ (projectOrbital(cam, EARTH_RADIUS_KM + 400, 0, 0));
  const back = /** @type {any} */ (projectOrbital(cam, -(EARTH_RADIUS_KM + 400), 0, 0));
  assert.equal(front.occluded, false);
  assert.equal(back.occluded, true);
  const north = /** @type {any} */ (projectOrbital(cam, 0, 0, 2 * EARTH_RADIUS_KM));
  assert.ok(north.y < 300, 'north is up');
  const east = /** @type {any} */ (projectOrbital(cam, 0, 2 * EARTH_RADIUS_KM, 0));
  assert.ok(east.x > 400, '+y appears to the right from +x');
  assert.equal(occludedByEarth([3e4, 0, 0], [2e4, 0, 0]), false);
  // The fit radius fills the shorter side of the canvas.
  const edge = /** @type {any} */ (projectOrbital(cam, 0, 0, 0));
  const disc = earthDisc(cam);
  assert.ok(disc.r > 0 && disc.r < 300 && edge);
  assert.equal(projectOrbital(cam, cam.pos[0] * 2, cam.pos[1] * 2, cam.pos[2] * 2), null, 'behind the camera');
});

test('fit radius frames the largest orbit, at least 1.6 Earth radii', () => {
  assert.equal(fitRadiusKm([]), 1.6 * EARTH_RADIUS_KM);
  const gps = new Float32Array(16).fill(NaN);
  gps.set([26560, 0, 0], 0);
  assert.ok(near(fitRadiusKm(gps), 1.1 * 26560, 0.01));
});

test('camera turns once per 600 s and stops under reduced motion', () => {
  assert.ok(near(cameraAzimuth((CAMERA_TURN_SEC / 4) * 1000, false), Math.PI / 2));
  assert.equal(cameraAzimuth(123456, true), 0);
});

test('surface records place a launch pad on Earth, in the right direction from the observer', () => {
  const t = Date.parse('2026-10-29T14:00:00Z');
  const obs = { lat: 27.5, lon: -80.6 };
  const r = surfaceRecord(28.5, -80.6, t, obs);
  assert.ok(near(Math.hypot(r[0], r[1], r[2]), EARTH_RADIUS_KM, 25), 'on the surface');
  assert.ok(near(r[3], 28.5 * DEG, 1e-6) && near(r[4], -80.6 * DEG, 1e-6));
  assert.ok(near(r[6], 0, 0.01), `azimuth ${r[6]} is north`);
  assert.ok(r[7] < 0 && r[7] > -1 * DEG, `elevation ${r[7]} just below the horizon`);
  assert.equal(projectRecord('sky', r, 0, { width: 400, height: 400 }), null);
  const m = /** @type {any} */ (projectRecord('map', r, 0, { width: 360, height: 180 }));
  assert.ok(near(m.x, 180 - 80.6, 1e-3) && near(m.y, 90 - 28.5, 1e-3));
  assert.equal(projectRecord('map', new Float32Array(8).fill(NaN), 0, { width: 400, height: 200 }), null);
});
