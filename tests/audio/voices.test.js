import test from 'node:test';
import assert from 'node:assert/strict';

import { VoicePool, MAX_VOICES_PER_WIDGET, MAX_VOICES_GLOBAL } from '../../src/audio/voices.js';

/** Fake instrument: records steals and, like Instrument.stealVoice, ends the voice 20 ms later. */
function owner(name) {
  const stolen = [];
  return {
    name,
    stolen,   // [voice, t]
    stealVoice(v, t) {
      stolen.push([v, t]);
      v.end = Math.min(v.end, Math.max(t, v.start) + 0.02);
    },
  };
}

function voice(o, start, { offTime = Infinity, end = Infinity, stolen = false } = {}) {
  return { owner: o, start, offTime, end, stolen };
}

function poolWith(max, voices) {
  const pool = new VoicePool(max);
  for (const v of voices) pool.add(v);
  return pool;
}

test('caps match audio-engine-core.md', () => {
  assert.equal(MAX_VOICES_PER_WIDGET, 16);
  assert.equal(MAX_VOICES_GLOBAL, 64);
  assert.equal(new VoicePool().max, 64);
});

test('makeRoom does nothing while under both caps', () => {
  const o = owner('a');
  const pool = poolWith(64, [voice(o, 0), voice(o, 1)]);
  pool.makeRoom(o, 3, 2);
  assert.equal(o.stolen.length, 0);
  assert.equal(pool.live(2, o).length, 2);
});

test('per-owner cap: steals the oldest held voice of that owner', () => {
  const o = owner('a');
  const a = voice(o, 0), b = voice(o, 1), c = voice(o, 2);
  const pool = poolWith(64, [b, a, c]);
  pool.makeRoom(o, 3, 5);
  assert.equal(o.stolen.length, 1);
  assert.equal(o.stolen[0][0], a);
  assert.equal(o.stolen[0][1], 5);
  assert.equal(a.stolen, true);
  assert.equal(pool.live(5, o).length, 2);
});

test('per-owner cap only counts that owner', () => {
  const o1 = owner('a'), o2 = owner('b');
  const pool = poolWith(64, [voice(o1, 0), voice(o1, 1), voice(o2, 2)]);
  pool.makeRoom(o2, 2, 3);
  assert.equal(o1.stolen.length, 0);
  assert.equal(o2.stolen.length, 0);
});

test('stealing prefers the oldest voice already in release, over older held voices', () => {
  const o = owner('a');
  const held = voice(o, 0);
  const relNew = voice(o, 1, { offTime: 2, end: 4 });
  const relOld = voice(o, 0.5, { offTime: 2.2, end: 4 });
  const pool = poolWith(64, [held, relNew, relOld]);
  pool.makeRoom(o, 3, 2.5);
  assert.equal(o.stolen.length, 1);
  assert.equal(o.stolen[0][0], relOld);
  assert.equal(held.stolen, false);
});

test('a voice whose release starts exactly at t counts as in release', () => {
  const o = owner('a');
  const held = voice(o, 0);
  const rel = voice(o, 1, { offTime: 2, end: 3 });
  const pool = poolWith(64, [held, rel]);
  pool.makeRoom(o, 2, 2);
  assert.equal(o.stolen[0][0], rel);
});

test('a voice with a note-off scheduled after t is still held', () => {
  const o = owner('a');
  const a = voice(o, 0);
  const b = voice(o, 1, { offTime: 3, end: 4.5 });
  const pool = poolWith(64, [a, b]);
  pool.makeRoom(o, 2, 2);
  assert.equal(o.stolen.length, 1);
  assert.equal(o.stolen[0][0], a);   // oldest held; b is not in release at t = 2
});

test('stolen voices do not count toward the caps', () => {
  const o = owner('a');
  const pool = poolWith(64, [voice(o, 0, { stolen: true }), voice(o, 1), voice(o, 2)]);
  pool.makeRoom(o, 3, 3);
  assert.equal(o.stolen.length, 0);
  assert.equal(pool.live(3, o).length, 2);
});

test('repeated makeRoom calls do not steal the same voice twice', () => {
  const o = owner('a');
  const pool = poolWith(64, [voice(o, 0), voice(o, 1)]);
  pool.makeRoom(o, 2, 2);
  pool.add(voice(o, 2));
  pool.makeRoom(o, 2, 2);
  assert.deepEqual(o.stolen.map(([v]) => v.start), [0, 1]);
});

test('prune removes voices whose end <= t, and ended voices do not count', () => {
  const o = owner('a');
  const pool = poolWith(64, [voice(o, 0, { offTime: 1, end: 1.5 }), voice(o, 0.5, { offTime: 1, end: 2 }), voice(o, 1)]);
  pool.makeRoom(o, 2, 2);
  assert.equal(o.stolen.length, 0);
  assert.equal(pool.voices.length, 1);
  assert.equal(pool.voices[0].start, 1);
});

test('voices scheduled in the future still count', () => {
  const o = owner('a');
  const now = voice(o, 0), future = voice(o, 10);
  const pool = poolWith(64, [future, now]);
  pool.makeRoom(o, 2, 1);
  assert.equal(o.stolen.length, 1);
  assert.equal(o.stolen[0][0], now);

  const o2 = owner('b');
  const f1 = voice(o2, 10), f2 = voice(o2, 11);
  const pool2 = poolWith(64, [f2, f1]);
  pool2.makeRoom(o2, 2, 1);
  assert.equal(o2.stolen.length, 1);
  assert.equal(o2.stolen[0][0], f1);
});

test('global cap: steals the oldest voice across owners', () => {
  const o1 = owner('a'), o2 = owner('b');
  const oldest = voice(o1, 0);
  const pool = poolWith(4, [voice(o1, 1), oldest, voice(o1, 2), voice(o2, 0.5)]);
  pool.makeRoom(o2, 16, 3);
  assert.equal(o1.stolen.length, 1);
  assert.equal(o1.stolen[0][0], oldest);
  assert.equal(o2.stolen.length, 0);
  assert.equal(pool.live(3).length, 3);
});

test('global cap prefers a released voice of another owner over older held voices', () => {
  const o1 = owner('a'), o2 = owner('b');
  const rel = voice(o2, 2, { offTime: 2.5, end: 5 });
  const pool = poolWith(3, [voice(o1, 0), voice(o1, 1), rel]);
  pool.makeRoom(o1, 16, 3);
  assert.equal(o2.stolen.length, 1);
  assert.equal(o2.stolen[0][0], rel);
  assert.equal(o1.stolen.length, 0);
});

test('per-owner cap is applied first, then the global cap', () => {
  const o1 = owner('a'), o2 = owner('b');
  const pool = poolWith(4, [voice(o1, 0), voice(o1, 3), voice(o2, 1), voice(o2, 2)]);
  pool.makeRoom(o2, 2, 5);
  assert.equal(o2.stolen.length, 1);
  assert.equal(o2.stolen[0][0].start, 1);
  assert.equal(o1.stolen.length, 0);   // room was made under the per-owner cap
  assert.equal(pool.live(5).length, 3);
});

test('makeRoom steals repeatedly until there is room under the global cap', () => {
  const o = owner('a');
  const pool = poolWith(2, [voice(o, 3), voice(o, 0), voice(o, 2), voice(o, 1)]);
  pool.makeRoom(o, 16, 5);
  assert.deepEqual(o.stolen.map(([v]) => v.start), [0, 1, 2]);
  assert.equal(pool.live(5).length, 1);
});

test('ofOwner, live and removeOwner', () => {
  const o1 = owner('a'), o2 = owner('b');
  const pool = poolWith(64, [voice(o1, 0), voice(o2, 0), voice(o1, 1, { end: 2 })]);
  assert.equal(pool.ofOwner(o1).length, 2);
  assert.equal(pool.live(3, o1).length, 1);
  assert.equal(pool.live(3).length, 2);
  pool.removeOwner(o1);
  assert.equal(pool.voices.length, 1);
  assert.equal(pool.voices[0].owner, o2);
});
