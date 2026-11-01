// Renderer behaviour that needs no real WebGL: a stub context records calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, createErrorThrottle, ERROR_REPEAT_MS } from '../src/visual/renderer.js';
import { DEFAULT_OBSERVER } from '../src/lib/settings.js';

/** A WebGL2 stand-in: constants are 0, create* returns a fresh handle, every other method records its call. */
function fakeGl() {
  /** @type {any[][]} */
  const calls = [];
  const gl = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (/^[A-Z0-9_]+$/.test(prop)) return 0;
      return (/** @type {any[]} */ ...args) => {
        calls.push([prop, ...args]);
        if (prop.startsWith('create')) return { kind: prop };
        if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return true;
        if (prop === 'getExtension') return args[0] === 'WEBGL_lose_context' ? { loseContext() {} } : null;
        if (prop === 'getUniformLocation') return {};
        return undefined;
      };
    },
  });
  return { gl, calls };
}

function setup({ sky = { on: () => () => {}, get: () => [], object: () => null } } = {}) {
  const { gl, calls } = fakeGl();
  const canvas = { getContext: () => gl, addEventListener() {}, removeEventListener() {}, clientWidth: 64, clientHeight: 48, width: 0, height: 0 };
  /** @type {any[]} */
  const records = [];
  /** @type {((t: number) => void)[]} */
  const rafs = [];
  const clock = { ms: 0 };
  const r = /** @type {any} */ (createRenderer(/** @type {any} */ (canvas), {
    sky, trace: (x) => records.push(x), now: () => clock.ms,
    raf: (fn) => { rafs.push(fn); return rafs.length; }, cancelRaf: () => {},
  }));
  return { r, calls, records, rafs, clock };
}

test('the renderer starts from the shared defaults', () => {
  const { r } = setup();
  assert.equal(r.available, true);
  assert.deepEqual(r.settings.observer, DEFAULT_OBSERVER);
  assert.notEqual(r.settings.observer, DEFAULT_OBSERVER, 'a copy, not the frozen default');
  assert.equal(r.settings.maxFlashesPerSecond, 3);
  r.dispose();
});

test('a frame that keeps throwing traces each message once, then a repeat count at most once per second', () => {
  const { r, records, rafs, clock } = setup();
  let message = 'boom';
  r.frame = () => { throw new Error(message); };
  r.start();
  for (let i = 0; i < 120; i++) { clock.ms += 16; /** @type {any} */ (rafs.shift())(clock.ms); }
  const errors = records.filter((x) => x.event === 'frameError');
  assert.equal(errors.length, 2, '1.9 s of failing frames: the first record and one repeat record');
  assert.deepEqual(errors[0].data, { message: 'boom' });
  assert.equal(errors[0].stage, 'VISUAL');
  assert.equal(errors[0].level, 'error');
  assert.equal(errors[1].data.message, 'boom');
  assert.ok(errors[1].data.repeats >= 60 && errors[1].data.repeats <= 63, String(errors[1].data.repeats));
  message = 'other';
  clock.ms += 16; /** @type {any} */ (rafs.shift())(clock.ms);
  assert.deepEqual(records.filter((x) => x.event === 'frameError').at(-1).data, { message: 'other' }, 'a new message is traced at once');
  r.stop();
  r.dispose();
});

test('createErrorThrottle counts repeats since the previous record', () => {
  /** @type {any[]} */
  const out = [];
  const report = createErrorThrottle((d) => out.push(d), 1000);
  report('a', 0);
  report('a', 10);
  report('a', 20);
  report('a', 1000);
  report('a', 1500);
  report('a', 2000);
  assert.deepEqual(out, [{ message: 'a' }, { message: 'a', repeats: 3 }, { message: 'a', repeats: 2 }]);
  assert.equal(ERROR_REPEAT_MS, 1000);
});

test('setSettings rejects a non-finite flash limit and changes nothing', () => {
  const { r } = setup();
  r.setSettings({ maxFlashesPerSecond: 1 });
  assert.equal(r.guard.threshold, 2);
  assert.equal(r.sceneGuard.threshold, 2);
  for (const bad of [NaN, Infinity, null]) {
    assert.throws(() => r.setSettings({ maxFlashesPerSecond: bad }), RangeError);
    assert.equal(r.settings.maxFlashesPerSecond, 1);
    assert.equal(r.guard.threshold, 2);
    assert.equal(r.sceneGuard.threshold, 2);
  }
  r.dispose();
});

test('the highlight finds its object through sky.object, also for ids with colons', () => {
  const id = 'jpl.cad:2024 AB:2026-11-01 12:30';
  const obj = { id, group: 'jpl.cad', source: 'jpl.cad', fields: {} };
  const sky = { on: () => () => {}, get: () => { throw new Error('get must not be used'); }, object: (/** @type {string} */ x) => (x === id ? obj : null) };
  const { r } = setup({ sky });
  /** @type {any[]} */
  const drawn = [];
  r.drawSprites = (/** @type {number} */ kind, /** @type {Float32Array} */ data) => drawn.push({ kind, x: data[0], y: data[1] });
  const positions = { ids: [], data: new Float32Array(0), stride: 8, index: new Map() };
  const ctx = { simMs: 0, observer: DEFAULT_OBSERVER };
  r.highlight(id);
  r.drawHighlight(positions, 'map', { width: 100, height: 50 }, ctx);
  assert.equal(drawn.length, 1);
  assert.deepEqual(drawn[0], { kind: 1, x: 50, y: 25 }, 'a group without positions draws at the centre');
  r.highlight('jpl.cad:missing');
  r.drawHighlight(positions, 'map', { width: 100, height: 50 }, ctx);
  assert.equal(drawn.length, 1, 'an object not held draws nothing');
  r.dispose();
});

test('an exit event forgets the object in the property resolver', () => {
  /** @type {Record<string, Set<Function>>} */
  const listeners = { enter: new Set(), update: new Set(), exit: new Set() };
  const sky = { on: (/** @type {string} */ t, /** @type {Function} */ fn) => { listeners[t].add(fn); return () => listeners[t].delete(fn); }, get: () => [], object: () => null };
  const { r } = setup({ sky });
  const layer = { id: 'l0', type: 'points', group: 'jpl.cad', exprProps: new Set(['size']), constants: {} };
  const obj = { id: 'jpl.cad:x', group: 'jpl.cad', source: 'jpl.cad', fields: {} };
  r.resolver.resolve(layer, obj.id, { pushed: { l0: { size: { [obj.id]: 5 } } } });
  r.resolver.resolve(layer, 'jpl.cad:y', { pushed: { l0: { size: { 'jpl.cad:y': 6 } } } });
  assert.equal(r.resolver.last.size, 2);
  for (const fn of listeners.exit) fn({ type: 'exit', obj, prev: obj, traceId: 't' });
  assert.equal(r.resolver.last.size, 1, 'only the exited object is forgotten');
  r.dispose();
  for (const set of Object.values(listeners)) assert.equal(set.size, 0, 'dispose removes sky listeners');
});

test('dispose deletes the vertex arrays with the other GL objects', () => {
  const { r, calls } = setup();
  r.dispose();
  const vaos = calls.filter((c) => c[0] === 'deleteVertexArray').map((c) => c[1]);
  assert.equal(vaos.length, 3);
  for (const v of vaos) assert.equal(v.kind, 'createVertexArray');
});
