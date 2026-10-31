import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFlashGuard, createLimitTail, limitStep, transitionThreshold, GRID_W, GRID_H, LIMIT_TAIL_SEC, LUMA_STEP } from '../src/visual/flash-guard.js';
import { linearToSrgb, luminance, srgbToLinear } from '../src/visual/color.js';

const FPS = 60;
const CELLS = GRID_W * GRID_H;

/** An sRGB frame: `rgb` inside the rectangle, `bg` elsewhere. */
function frame(rgb, rect = { x: 0, y: 0, w: GRID_W, h: GRID_H }, bg = [0, 0, 0]) {
  const px = new Uint8Array(CELLS * 4);
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const c = inside ? rgb : bg;
      const i = (y * GRID_W + x) * 4;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
  return px;
}

/** Runs a square wave between two frames at `hz` for `seconds`; returns the guard results and trace records. */
function run({ hz, seconds, a, b, maxFlashesPerSecond = 3 }) {
  const records = [];
  const guard = createFlashGuard({ maxFlashesPerSecond, trace: (r) => records.push(r), clock: () => 0 });
  const results = [];
  for (let f = 0; f < seconds * FPS; f++) {
    const t = (f * 1000) / FPS;
    const phase = Math.floor((t / 1000) * hz * 2) % 2;
    results.push(guard.frame(phase ? b : a, t));
  }
  return { guard, results, records };
}

const black = frame([0, 0, 0]);
const white = frame([255, 255, 255]);

test('a 5 Hz full-frame flash is limited and traced', () => {
  const { results, records } = run({ hz: 5, seconds: 2, a: black, b: white });
  const first = results.findIndex((r) => r.limiting);
  assert.ok(first > 0, 'guard intervenes');
  assert.ok(first <= 0.7 * FPS, `guard intervenes by the sixth transition (frame ${first})`);
  assert.equal(records[0].stage, 'SAFETY');
  assert.equal(records[0].component, 'flash-guard');
  assert.equal(records[0].event, 'flashLimit');
  assert.equal(records[0].level, 'warn');
  assert.equal(records[0].data.kind, 'general');
  assert.ok(records[0].traceId);
});

test('a 2 Hz full-frame flash passes', () => {
  const { results, records } = run({ hz: 2, seconds: 5, a: black, b: white });
  assert.ok(results.every((r) => !r.limiting));
  assert.equal(records.length, 0);
});

test('a small-area 5 Hz flash passes', () => {
  // 8×8 cells is 64 of the 336 cells of the 10° window, below the 25% concurrency share.
  const small = frame([255, 255, 255], { x: 10, y: 10, w: 8, h: 8 });
  const { results } = run({ hz: 5, seconds: 3, a: black, b: small });
  assert.ok(results.every((r) => !r.limiting));
  // Two small flashing areas far apart do not combine within one window.
  const px = frame([255, 255, 255], { x: 0, y: 0, w: 9, h: 9 });
  const far = frame([255, 255, 255], { x: 50, y: 35, w: 9, h: 9 });
  for (let i = 0; i < px.length; i++) px[i] = Math.max(px[i], far[i]);
  assert.ok(run({ hz: 5, seconds: 3, a: black, b: px }).results.every((r) => !r.limiting));
});

test('a flash covering a quarter of one 10° window is limited', () => {
  const quarter = frame([255, 255, 255], { x: 20, y: 20, w: 12, h: 8 }); // 96 cells ≥ 84
  assert.ok(run({ hz: 5, seconds: 2, a: black, b: quarter }).results.some((r) => r.limiting));
});

test('a saturated red flash without a luminance change is limited as a red flash', () => {
  // Grey with the luminance of pure red: equal relative luminance, different chromaticity.
  const grey = Math.round(255 * linearToSrgbApprox(0.2126));
  const red = frame([255, 0, 0]);
  const greyFrame = frame([grey, grey, grey]);
  const L = (c) => luminance(srgbToLinear(c[0] / 255), srgbToLinear(c[1] / 255), srgbToLinear(c[2] / 255));
  assert.ok(Math.abs(L([255, 0, 0]) - L([grey, grey, grey])) < LUMA_STEP, 'no general flash');
  const { results, records } = run({ hz: 5, seconds: 2, a: greyFrame, b: red });
  assert.ok(results.some((r) => r.limiting));
  assert.equal(records[0].data.kind, 'red');
});

test('bright changes above 0.8 luminance are not flashes', () => {
  const light = frame([240, 240, 240]);
  const lighter = frame([255, 255, 255]);
  assert.ok(run({ hz: 8, seconds: 2, a: light, b: lighter }).results.every((r) => !r.limiting));
});

test('the limit only gets stricter: 0 intervenes on one transition, values above 3 act as 3', () => {
  assert.equal(transitionThreshold(0), 1);
  assert.equal(transitionThreshold(3), 6);
  assert.equal(transitionThreshold(10), 6);
  assert.equal(transitionThreshold(NaN), 6);
  assert.equal(transitionThreshold(1.5), 3);
  assert.equal(transitionThreshold(2.4), 4, 'a fractional limit rounds down');
  const g = createFlashGuard({ maxFlashesPerSecond: 0 });
  g.frame(black, 0);
  assert.equal(g.frame(white, 16).limiting, true);
  const loose = createFlashGuard({ maxFlashesPerSecond: 99 });
  assert.equal(loose.threshold, 6);
  loose.setMaxFlashes(1);
  assert.equal(loose.threshold, 2);
});

test('the guard ends its intervention once flashing stops', () => {
  const records = [];
  const g = createFlashGuard({ trace: (r) => records.push(r), clock: () => 0 });
  let t = 0;
  for (let f = 0; f < FPS; f++, t += 1000 / FPS) g.frame(Math.floor(f / 6) % 2 ? white : black, t);
  assert.equal(g.limiting, true);
  for (let f = 0; f < 2 * FPS; f++, t += 1000 / FPS) g.frame(black, t);
  assert.equal(g.limiting, false);
  assert.deepEqual(records.map((r) => r.event), ['flashLimit', 'flashLimitEnd']);
});

test('with the limiter in the loop, the output never flashes more than 3 times in 1 s', () => {
  // Simulates the composite pass: while limiting, each pixel's linear value moves at most limitStep(dt).
  for (const hz of [4, 5, 8, 12, 25]) {
    const g = createFlashGuard({ encoding: 'linear' });
    let out = 0;
    const lum = [];
    const dt = 1 / FPS;
    for (let f = 0; f < 6 * FPS; f++) {
      const t = f * dt * 1000;
      const target = Math.floor(f * dt * hz * 2) % 2;
      out = g.limiting ? out + Math.max(-limitStep(dt), Math.min(limitStep(dt), target - out)) : target;
      const px = new Float32Array(CELLS * 4).fill(out);
      g.frame(px, t);
      lum.push([t, out]);
    }
    const transitions = countTransitions(lum);
    let worst = 0;
    for (const t0 of transitions) worst = Math.max(worst, transitions.filter((t) => t >= t0 && t <= t0 + 1000).length);
    assert.ok(worst <= 6, `${hz} Hz: ${worst} transitions in 1 s`);
  }
});

test('limitStep keeps a 1/6 s half-cycle below the 10% flash threshold', () => {
  assert.ok(limitStep(1 / 60) * 10 < LUMA_STEP);
  assert.ok(limitStep(1 / 120) * 20 < LUMA_STEP);
  assert.equal(limitStep(1), limitStep(1 / 30), 'a long frame does not allow a large step');
});

test('the guard rejects a frame of the wrong size', () => {
  assert.throws(() => createFlashGuard().frame(new Uint8Array(16), 0), /expects 12288 values/);
});

/** Reference transition counter: reversals of at least 0.1 with the darker state below 0.8. */
function countTransitions(samples) {
  const out = [];
  let ext = samples[0][1], dir = 0;
  for (const [t, L] of samples) {
    const d = L - ext;
    if ((dir === 1 && d > 0) || (dir === -1 && d < 0)) ext = L;
    else if (Math.abs(d) >= 0.1 && Math.min(L, ext) < 0.8) { out.push(t); dir = Math.sign(d); ext = L; }
  }
  return out;
}

function linearToSrgbApprox(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/**
 * Model of the renderer's loop (doc/visuals.md, Visual safety): an output guard and a scene
 * guard, the limit tail, and output storage that is float or 8-bit with steps rounded toward
 * the previous frame. Returns the worst count of output transitions in any 1 s window.
 */
function renderLoop({ fps, hz, lo, hi, seconds = 8, quantize }) {
  const g = createFlashGuard({ encoding: 'linear' });
  const sg = createFlashGuard({ encoding: 'linear', measured: 'scene' });
  const tail = createLimitTail();
  const store = (v) => (quantize ? srgbToLinear(Math.round(linearToSrgb(v) * 255) / 255) : v);
  const dt = 1 / fps;
  let out = null;
  const lum = [];
  for (let f = 0; f < seconds * fps; f++) {
    const t = f * dt * 1000;
    const scene = Math.floor(f * dt * hz * 2) % 2 ? hi : lo;
    const was = g.limiting || sg.limiting;
    if (out === null || !tail.active(was)) {
      out = store(scene);
    } else {
      const stepped = out + Math.max(-limitStep(dt), Math.min(limitStep(dt), scene - out));
      if (quantize) {
        const code = linearToSrgb(stepped) * 255;
        const prevCode = Math.round(linearToSrgb(out) * 255);
        out = srgbToLinear((code >= prevCode ? Math.floor(code) : Math.ceil(code)) / 255);
      } else {
        out = stepped;
      }
    }
    g.frame(new Float32Array(CELLS * 4).fill(out), t);
    sg.frame(new Float32Array(CELLS * 4).fill(scene), t);
    tail.after(was, g.limiting || sg.limiting, dt);
    lum.push([t, out]);
  }
  const transitions = countTransitions(lum);
  let worst = 0;
  for (const t0 of transitions) worst = Math.max(worst, transitions.filter((t) => t >= t0 && t <= t0 + 1000).length);
  return worst;
}

test('the full loop never shows more than 3 flashes in 1 s at any frame rate or storage', () => {
  for (const quantize of [false, true]) {
    for (const fps of [30, 60, 120, 144, 240]) {
      for (const hz of [3.5, 4, 8, 15]) {
        for (const [lo, hi] of [[0, 1], [0.7, 1], [0.05, 0.3]]) {
          const worst = renderLoop({ fps, hz, lo, hi, quantize });
          assert.ok(worst <= 6, `${quantize ? '8-bit' : 'float'} ${fps} Hz display, ${hz} Hz strobe ${lo}–${hi}: ${worst} transitions in 1 s`);
        }
      }
    }
  }
});

test('the limit stays on after release for LIMIT_TAIL_SEC of limited frame time', () => {
  const tail = createLimitTail();
  assert.equal(tail.active(false), false);
  tail.after(true, false, 1 / 60);
  let frames = 0;
  while (tail.active(false)) { tail.after(false, false, 1 / 10); frames++; }
  assert.equal(frames, Math.ceil(LIMIT_TAIL_SEC * 30), 'slow frames count at most 1/30 s each');
  tail.after(false, true, 1 / 60);
  assert.equal(tail.active(true), true);
});

test('flashLimit records name what was measured', () => {
  const records = [];
  const g = createFlashGuard({ measured: 'scene', trace: (r) => records.push(r), clock: () => 0 });
  let t = 0;
  for (let f = 0; f < FPS; f++, t += 1000 / FPS) g.frame(Math.floor(f / 6) % 2 ? white : black, t);
  assert.equal(records[0].data.measured, 'scene');
});
