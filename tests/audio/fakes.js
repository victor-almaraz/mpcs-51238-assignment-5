// Small fakes for testing audio logic in Node, where Web Audio does not exist.

import assert from 'node:assert/strict';

export const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

/**
 * Fake AudioParam that records automation calls as arrays: [method, ...args].
 * `hold: false` omits cancelAndHoldAtTime (Firefox). `trapValue: true` makes reading or
 * writing `.value` throw, to prove code never relies on it.
 */
export function fakeParam({ hold = true, value = 0, trapValue = false } = {}) {
  const calls = [];
  const p = {
    calls,
    setValueAtTime(v, t) { calls.push(['setValueAtTime', v, t]); return p; },
    linearRampToValueAtTime(v, t) { calls.push(['linearRampToValueAtTime', v, t]); return p; },
    setTargetAtTime(v, t, tau) { calls.push(['setTargetAtTime', v, t, tau]); return p; },
    cancelScheduledValues(t) { calls.push(['cancelScheduledValues', t]); return p; },
  };
  if (hold) p.cancelAndHoldAtTime = (t) => { calls.push(['cancelAndHoldAtTime', t]); return p; };
  if (trapValue) {
    Object.defineProperty(p, 'value', {
      get() { throw new Error('param.value read'); },
      set() { throw new Error('param.value written'); },
    });
  } else {
    p.value = value;
  }
  return p;
}

/** Compares recorded calls with expected ones; numbers are compared with `close`. */
export function assertCalls(actual, expected, eps = 1e-9) {
  assert.equal(actual.length, expected.length, `call count: ${JSON.stringify(actual)}`);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i], e = expected[i];
    assert.equal(a.length, e.length, `call ${i} arity: ${JSON.stringify(a)}`);
    for (let j = 0; j < e.length; j++) {
      if (typeof e[j] === 'number' && Number.isFinite(e[j])) close(a[j], e[j], eps);
      else assert.equal(a[j], e[j], `call ${i} arg ${j}`);
    }
  }
}

/** Fake instrument recording noteOn/noteOff calls. */
export function fakeInst(name = 'inst') {
  const ons = [];
  const offs = [];
  return {
    name,
    ons,     // [pitch, velocity, time, source]
    offs,    // [pitch, time, source]
    noteOn(pitch, velocity, time, source) { ons.push([pitch, velocity, time, source]); },
    noteOff(pitch, time, source) { offs.push([pitch, time, source]); },
  };
}

/** Replaces globalThis.setInterval/clearInterval; call restore() when done. */
export function installFakeTimers() {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const timers = new Map();
  const cleared = [];
  let nextId = 1;
  globalThis.setInterval = (fn, ms) => {
    const id = nextId++;
    timers.set(id, { fn, ms });
    return id;
  };
  globalThis.clearInterval = (id) => {
    cleared.push(id);
    timers.delete(id);
  };
  return {
    timers,
    cleared,
    /** Runs every active interval callback once. */
    fire() { for (const { fn } of [...timers.values()]) fn(); },
    restore() {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    },
  };
}
