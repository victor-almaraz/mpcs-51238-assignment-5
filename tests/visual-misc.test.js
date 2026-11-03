import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioNow } from '../src/visual/av-sync.js';
import { isReducedMotion, pixelRatioFor, clampPixelRatio, watchSystemReducedMotion } from '../src/visual/motion.js';
import { summaryLines, UNAVAILABLE_STATUS } from '../src/visual/summary.js';
import { parseHex, srgbToLinear, linearToSrgb, luminance, chromaticityUV, redRatio, sampleColormap, WHITE_UV } from '../src/visual/color.js';
import { createRenderer, safeTrace } from '../src/visual/renderer.js';
import { createFlashGuard } from '../src/visual/flash-guard.js';

test('audioNow uses the output timestamp, or subtracts output latency', () => {
  const ctx = { currentTime: 10, outputLatency: 0.04, getOutputTimestamp: () => ({ contextTime: 9.9, performanceTime: 1000 }) };
  assert.ok(Math.abs(audioNow(ctx, () => 1050) - 9.95) < 1e-9);
  const ahead = { ...ctx, getOutputTimestamp: () => ({ contextTime: 10.5, performanceTime: 1000 }) };
  assert.ok(Math.abs(audioNow(ahead, () => 1050) - 9.96) < 1e-9, 'a timestamp ahead of currentTime is not used');
  const nan = { currentTime: 10, baseLatency: 0.01, getOutputTimestamp: () => ({ contextTime: NaN, performanceTime: 0 }) };
  assert.ok(Math.abs(audioNow(nan) - 9.99) < 1e-9);
  assert.equal(audioNow({ currentTime: 3 }), 3);
});

test('reduced motion: the setting can only make the OS preference stricter', () => {
  assert.equal(isReducedMotion('system', false), false);
  assert.equal(isReducedMotion('system', true), true);
  assert.equal(isReducedMotion('on', false), true);
  assert.equal(isReducedMotion('off', false), true, 'unknown values act as on');
  let seen = null;
  const listeners = [];
  const mq = { matches: true, addEventListener: (_, fn) => listeners.push(fn), removeEventListener: () => listeners.pop() };
  const stop = watchSystemReducedMotion((r) => { seen = r; }, { matchMedia: () => mq });
  assert.equal(seen, true);
  mq.matches = false;
  listeners[0]();
  assert.equal(seen, false);
  stop();
  assert.equal(listeners.length, 0);
  watchSystemReducedMotion((r) => { seen = r; }, {});
  assert.equal(seen, false);
});

test('pixel ratio: installation up to 2, preview at the settings scale', () => {
  assert.equal(pixelRatioFor({ installation: true, devicePixelRatio: 3 }), 2);
  assert.equal(pixelRatioFor({ installation: true, devicePixelRatio: 1.5 }), 1.5);
  assert.equal(pixelRatioFor({ devicePixelRatio: 2 }), 2, 'the default preview is as sharp as the display');
  assert.equal(pixelRatioFor({ previewScale: 0.5, devicePixelRatio: 2 }), 1);
  assert.equal(pixelRatioFor({ previewScale: 0.1 }), 0.25);
  assert.equal(pixelRatioFor({ previewScale: 4, devicePixelRatio: 3 }), 2);
  assert.equal(clampPixelRatio(NaN), 1);
});

test('colour helpers', () => {
  assert.deepEqual(parseHex('#ff8000'), [1, 128 / 255, 0]);
  assert.equal(parseHex('#fff'), null);
  assert.ok(Math.abs(linearToSrgb(srgbToLinear(0.5)) - 0.5) < 1e-9);
  assert.ok(Math.abs(luminance(1, 1, 1) - 1) < 1e-9);
  assert.deepEqual(chromaticityUV(0, 0, 0), [...WHITE_UV]);
  const [u, v] = chromaticityUV(1, 0, 0);
  assert.ok(Math.abs(u - 0.4507) < 1e-3 && Math.abs(v - 0.5229) < 1e-3, 'sRGB red primary');
  const [wu, wv] = chromaticityUV(1, 1, 1);
  assert.ok(Math.abs(wu - WHITE_UV[0]) < 1e-3 && Math.abs(wv - WHITE_UV[1]) < 1e-3);
  assert.equal(redRatio(1, 0, 0), 1);
  assert.deepEqual(sampleColormap('night', 0), parseHex('#05070c'));
  assert.deepEqual(sampleColormap('ice', 1), parseHex('#d6f3ff'));
  assert.deepEqual(sampleColormap('nope', 0.5), parseHex('#1b2a4a'));
});

test('the guard reads linear readbacks as linear and sRGB frames as sRGB', () => {
  // Linear 0.2 is sRGB 0.48; a 0.2 ↔ 0 flash at 5 Hz must trip in both encodings.
  for (const encoding of ['linear', 'srgb']) {
    const g = createFlashGuard({ encoding });
    const hi = encoding === 'linear' ? Math.round(0.2 * 255) : Math.round(linearToSrgb(0.2) * 255);
    let limited = false;
    for (let f = 0; f < 120; f++) {
      const v = Math.floor(f / 6) % 2 ? hi : 0;
      limited ||= g.frame(new Uint8Array(64 * 48 * 4).fill(v), (f * 1000) / 60).limiting;
    }
    assert.ok(limited, encoding);
  }
});

test('summary lines list followed groups with counts and freshness', () => {
  const sky = {
    get: (g) => (g === 'jpl.cad' ? [{ source: 'jpl.cad' }, { source: 'jpl.cad' }] : g === 'swpc.kp' ? [{ source: 'swpc.kp' }] : []),
    freshness: (s) => ({ state: s === 'jpl.cad' ? 'fresh' : 'stale' }),
  };
  assert.deepEqual(summaryLines(['swpc.kp', 'jpl.cad', 'jpl.cad'], sky), ['jpl.cad: 2 objects, fresh', 'swpc.kp: 1 object, stale']);
  assert.deepEqual(summaryLines([], sky), ['This piece follows no groups.']);
});

test('without WebGL2 the renderer is unavailable, traces the fallback and summarizes', () => {
  const records = [];
  const canvas = /** @type {any} */ ({ getContext: () => null });
  const sky = { get: (g) => (g === 'celestrak.stations' ? [{ source: 'celestrak.stations' }] : []), on: () => () => {} };
  const r = /** @type {any} */ (createRenderer(canvas, { trace: (x) => records.push(x), sky }));
  assert.equal(r.available, false);
  assert.equal(r.statusText, UNAVAILABLE_STATUS);
  assert.equal(UNAVAILABLE_STATUS, 'Visuals unavailable (WebGL2)');
  assert.equal(records[0].stage, 'VISUAL');
  assert.equal(records[0].event, 'fallback');
  assert.deepEqual(records[0].data, { reason: 'webgl2' });
  r.setLayers([{ id: 'l0', type: 'points', group: 'celestrak.stations', props: {} }]);
  assert.deepEqual(r.summaryLines(), ['celestrak.stations: 1 object']);
  r.setGroups(['jpl.cad']);
  assert.deepEqual(r.summaryLines(), ['jpl.cad: 0 objects']);
  for (const m of ['setView', 'setLayerValues', 'setBackground', 'setDesaturate', 'setSettings', 'start', 'stop', 'highlight', 'dispose']) assert.doesNotThrow(() => r[m]({}));
});

test('safeTrace never throws into the frame loop', () => {
  const original = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => safeTrace(() => { throw new TypeError('bad record'); })({}));
  } finally { console.error = original; }
  assert.doesNotThrow(() => safeTrace(undefined)({}));
});
