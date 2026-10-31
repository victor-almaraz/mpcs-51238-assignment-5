import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildConfig, secretKeyFrom } from '../../supabase/functions/harvest/config.js';
import { canonicalJson, hashFields } from '../../supabase/functions/harvest/hash.js';
import { normalizers } from '../../supabase/functions/harvest/normalizers/index.js';
import { enabledMatcher, loadRegistry, RegistryError } from '../../supabase/functions/harvest/registry.js';
import { isDue } from '../../supabase/functions/harvest/scheduler.js';

const sources = JSON.parse(readFileSync(new URL('../../supabase/functions/harvest/sources.json', import.meta.url), 'utf8'));
const vars = { LL2_BASE: 'https://ll.thespacedevs.com/2.3.0' };
const registry = loadRegistry(sources, { normalizers, vars });
const entry = (id) => registry.find((e) => e.id === id);
const at = (s) => Date.parse(s);

test('the committed registry is valid and substitutes LL2_BASE', () => {
  assert.equal(entry('ll2.upcoming').url, 'https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=10&mode=normal');
  assert.ok(registry.every((e) => e.host));
});

test('an invalid registry fails with a message naming the entry', () => {
  const bad = structuredClone(sources);
  bad[5].normalizer = 'nope';
  assert.throws(() => loadRegistry(bad, { normalizers, vars }), (err) => err instanceof RegistryError && /entry 5 \(swpc\.wind\).*unknown normalizer nope/.test(err.message));
  const extra = structuredClone(sources);
  extra[0].intervalSeconds = 1;
  assert.throws(() => loadRegistry(extra, { normalizers, vars }), /celestrak\.stations.*unknown key intervalSeconds/);
  assert.throws(() => loadRegistry(sources, { normalizers, vars: {} }), /ll2\.upcoming.*LL2_BASE/);
});

test('a 60 s source is due on consecutive one-minute ticks with up to 15 s jitter', () => {
  const e = entry('swpc.wind');
  let last = at('2026-10-30T03:00:14Z');
  for (const tickAt of ['2026-10-30T03:01:00Z', '2026-10-30T03:02:13Z', '2026-10-30T03:03:00Z']) {
    assert.ok(isDue(e, { last_attempt_at: new Date(last).toISOString() }, at(tickAt)), tickAt);
    last = at(tickAt);
  }
  assert.equal(isDue(e, { last_attempt_at: '2026-10-30T03:00:00Z' }, at('2026-10-30T03:00:44Z')), false);
});

test('halted, disabled, backoff and SOURCES_ENABLED are respected', () => {
  const e = entry('swpc.kp');
  const now = at('2026-10-30T03:00:00Z');
  assert.equal(isDue(e, undefined, now), true);
  assert.equal(isDue(e, { halted: true }, now), false);
  assert.equal(isDue({ ...e, enabled: false }, undefined, now), false);
  assert.equal(isDue(e, { next_attempt_at: '2026-10-30T03:00:01Z' }, now), false);
  const only = enabledMatcher('swpc.*,celestrak.stations');
  assert.equal(isDue(e, undefined, now, only), true);
  assert.equal(isDue(entry('jpl.cad'), undefined, now, only), false);
  assert.equal(only('celestrak.stations'), true);
  assert.equal(only('celestrak.visual'), false);
});

test('CelesTrak is never fetched before last_success_at + interval', () => {
  const e = entry('celestrak.stations');
  const st = { last_attempt_at: '2026-10-30T01:00:00Z', last_success_at: '2026-10-30T01:00:00Z' };
  assert.equal(isDue(e, st, at('2026-10-30T01:00:00Z') + 7495_000), false);
  assert.equal(isDue(e, st, at('2026-10-30T01:00:00Z') + 7500_000), true);
});

test('canonical JSON sorts keys and the hash ignores key order', async () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: null } }), '{"a":{"c":null,"d":[1,{"e":3,"f":2}]},"b":1}');
  assert.equal(await hashFields({ a: 1, b: 2 }), await hashFields({ b: 2, a: 1 }));
  assert.match(await hashFields({ a: 1 }), /^[0-9a-f]{64}$/);
});

test('config reads the injected secret keys and validates the contact', () => {
  assert.equal(secretKeyFrom({ SUPABASE_SECRET_KEYS: '{"default":"sb_secret_x"}' }), 'sb_secret_x');
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_y', WORKER_CONTACT: 'me@example.edu', LL2_BASE: vars.LL2_BASE };
  assert.equal(buildConfig(env, sources).userAgent, 'Sphaerenmusik/0.1.0 (me@example.edu)');
  assert.throws(() => buildConfig({ ...env, WORKER_CONTACT: 'Sphärenmusik' }, sources), /ASCII/);
  assert.throws(() => buildConfig({ ...env, LL2_BASE: '' }, sources), /missing environment variable: LL2_BASE/);
  assert.throws(() => buildConfig({ ...env, LOG_LEVEL: 'loud' }, sources), /LOG_LEVEL/);
});

test('malformed SUPABASE_SECRET_KEYS is reported as invalid JSON, not as missing', () => {
  assert.throws(() => secretKeyFrom({ SUPABASE_SECRET_KEYS: '{default:' }), /not valid JSON/);
});
