import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadGuide, readPageSource } from '../src/learn/guide.js';
import { LANDING_FILE, loadLanding, parseLanding } from '../src/learn/landing.js';
import { fetchSnapshot, summarize } from '../src/landing/live.js';
import { satrecs, splitAtAntimeridian, subPoint, subsolarPoint, sunCos, terminator } from '../src/landing/orbits.js';

const markdown = readFileSync(LANDING_FILE, 'utf8');
const landing = parseLanding(markdown);
const stations = JSON.parse(readFileSync(new URL('../worker/test/expected/celestrak-stations-1.json', import.meta.url), 'utf8'));
const iss = stations.find((o) => o.id === 'celestrak.stations:25544');

test('front matter, one h1 and the section headings of doc/ui.md', async () => {
  assert.equal(landing.title, 'Sphärenmusik');
  assert.ok(landing.description.length > 0);
  assert.deepEqual(landing.sections.map((s) => [s.depth, s.heading]), [
    [1, 'Sphärenmusik'],
    [2, 'The music of the spheres'],
    [2, 'Four sister sciences: the quadrivium'],
    [2, 'What Sphärenmusik does'],
    [2, 'How it works'],
    [2, 'What is real'],
    [2, 'Further reading'],
  ]);
  // The page renders the headings itself; the section bodies hold none.
  const html = (await loadLanding()).sections.map((s) => s.html).join('');
  assert.equal((html.match(/<h[12][ >]/g) ?? []).length, 0);
});

test('the How it works script is the first runnable example of first-piece', () => {
  const how = landing.sections.find((s) => s.heading === 'How it works');
  const first = loadGuide().find((p) => p.slug === 'first-piece').examples[0].source;
  assert.deepEqual(how.code, [first]);
});

test('ISS figures agree with the saved element set', () => {
  const periodMin = 1440 / iss.fields.meanMotion;
  const hz = 1 / (periodMin * 60);
  const octaves = Math.ceil(Math.log2(110 / hz));
  const raised = hz * 2 ** octaves;
  assert.ok(Math.abs(periodMin - 93) < 1, `period ${periodMin}`);
  assert.equal(octaves, 20);
  assert.ok(Math.abs(raised - 188) < 1, `raised ${raised}`);
  assert.match(markdown, /every 93 minutes/);
  assert.match(markdown, /twenty octaves/i);
  assert.match(markdown, /about 188 Hz/);
  assert.match(markdown, /about 0\.00018 Hz/);
  assert.ok(Math.abs(hz - 0.00018) < 0.000005);
});

test('live strip summary: values, next future launch and freshness', () => {
  const now = Date.parse('2026-10-30T03:00:00Z');
  const obj = (group, key, fields) => ({ id: `${group}:${key}`, source: group, group, fields });
  const st = (source, intervalSec, lastSuccessAt) => ({ source, intervalSec, lastAttemptAt: lastSuccessAt, lastSuccessAt, lastOk: true, halted: false });
  const items = summarize({
    objects: [
      obj('swpc.kp', 'planetary', { kp: 1, kpEstimated: 0.67 }),
      obj('swpc.wind', 'l1', { speed: 314.7 }),
      obj('celestrak.stations', '1', {}), obj('celestrak.stations', '2', {}),
      obj('ll2.upcoming', 'a', { name: 'Past', net: '2026-10-30T02:00:00Z' }),
      obj('ll2.upcoming', 'b', { name: 'Later', net: '2026-11-02T00:00:00Z' }),
      obj('ll2.upcoming', 'c', { name: 'Soon', net: '2026-10-30T18:21:00Z' }),
    ],
    statuses: [st('swpc.kp', 60, '2026-10-30T02:59:30Z'), st('swpc.wind', 60, '2026-10-30T02:50:00Z')],
  }, now);
  assert.deepEqual(items.map((i) => [i.label, i.value, i.freshness.state]), [
    ['Kp', '0.67', 'fresh'],
    ['Solar wind', '315 km/s', 'stale'],
    ['Stations in orbit', '2', 'loading'],
    ['Next launch', 'Soon · 2026-10-30 18:21 UTC', 'loading'],
  ]);
});

test('ground track: ISS stays within its inclination; subsolar latitude at the solstice', () => {
  const [s] = satrecs([iss]);
  const t0 = Date.parse(iss.fields.epoch);
  for (let m = 0; m < 100; m += 5) {
    const p = subPoint(s.satrec, new Date(t0 + m * 60_000));
    assert.ok(Math.abs(p.lat) <= iss.fields.inclination + 0.2, `lat ${p.lat}`);
  }
  const sun = subsolarPoint(new Date('2026-12-21T12:00:00Z'));
  assert.ok(Math.abs(sun.lat + 23.44) < 0.1, `sun lat ${sun.lat}`);
  assert.ok(Math.abs(sun.lon) < 1.5, `sun lon ${sun.lon}`);
  assert.ok(sunCos(sun.lat, sun.lon, sun) > 0.999);
  assert.deepEqual(splitAtAntimeridian([{ lat: 0, lon: 170 }, { lat: 0, lon: 179 }, { lat: 0, lon: -179 }]).map((r) => r.length), [2, 1]);
});

test('terminator: the Sun is on the horizon on the curve and below it toward the night pole', () => {
  for (const sun of [subsolarPoint(new Date('2026-06-21T12:00:00Z')), subsolarPoint(new Date('2026-12-21T03:00:00Z')), { lat: 0.5, lon: 40 }]) {
    for (let lon = -180; lon <= 180; lon += 15) {
      const t = terminator(lon, sun);
      assert.ok(Math.abs(sunCos(t.lat, lon, sun)) < 0.01, `on the curve at ${lon}`);
      const inside = t.lat + (t.nightPole - t.lat) / 2;
      assert.ok(sunCos(inside, lon, sun) < 0, `night side at ${lon}`);
    }
  }
});

test('objects with invalid elements are omitted', () => {
  assert.equal(satrecs([{ id: 'x', fields: { name: 'bad' } }, iss]).length, 1);
});

test('the How it works code is highlighted with the editor classes and keeps its text', async () => {
  const how = (await loadLanding()).sections.find((s) => s.heading === 'How it works');
  const code = how.html.match(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/)[1];
  assert.match(code, /<span class="syn-keyword">const<\/span>/);
  assert.match(code, /<span class="syn-function">additive<\/span>/);
  const text = code.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  assert.equal(text.trimEnd(), how.code[0]);
});

/** A supabase-js stand-in that answers the strip's two reads. */
function snapshotClient(skyRows, statusRows) {
  const result = (data) => {
    const q = { in: () => q, is: () => q, then: (ok, fail) => Promise.resolve({ data, error: null }).then(ok, fail) };
    return q;
  };
  return { from: (table) => ({ select: () => result(table === 'sky_objects' ? skyRows : statusRows) }) };
}

test('the live strip drops invalid rows and traces each one', async () => {
  const good = { id: 'swpc.kp:now', source: 'swpc.kp', group_key: 'swpc.kp', fields: { kp: 2 }, trace_id: 't1', updated_at: '2026-10-30T02:59:00Z', removed_at: null };
  const bad = { ...good, id: 'swpc.kp:bad', fields: { kp: 'x', v: [1] } };
  const status = { source_id: 'swpc.kp', interval_sec: 60, last_attempt_at: null, last_success_at: null, last_ok: null, halted: false };
  const records = [];
  const snap = await fetchSnapshot(snapshotClient([good, bad], [status, { source_id: '' }]), { trace: (r) => records.push(r) });
  assert.deepEqual(snap.objects.map((o) => o.id), ['swpc.kp:now']);
  assert.equal(snap.statuses.length, 1);
  assert.deepEqual(records.map((r) => [r.stage, r.component, r.event, r.level, r.data.table]), [
    ['REALTIME', 'landing', 'invalid_row', 'warn', 'sky_objects'],
    ['REALTIME', 'landing', 'invalid_row', 'warn', 'source_status'],
  ]);
  assert.match(records[0].data.error, /field v/);
});

test('readPageSource: null for a bad slug or a missing page; other read errors are thrown', () => {
  assert.equal(readPageSource('../etc'), null);
  assert.equal(readPageSource('no-such-page'), null);
  const dir = mkdtempSync(join(tmpdir(), 'learn-'));
  const cwd = process.cwd();
  try {
    mkdirSync(join(dir, 'content', 'learn', 'folder.md'), { recursive: true });
    writeFileSync(join(dir, 'content', 'learn', 'page.md'), '# x');
    process.chdir(dir);
    assert.equal(readPageSource('page'), '# x');
    assert.throws(() => readPageSource('folder'), /EISDIR/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
