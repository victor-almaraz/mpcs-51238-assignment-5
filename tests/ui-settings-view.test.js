import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../src/lib/settings.js';
import { SETTING_DEFS, applySetting, getPath, parseSettingsJson, searchSettings, setPath, settingsJson } from '../src/ui/settings-view.js';

const leaves = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (
  v && typeof v === 'object' && k !== 'observer' ? leaves(v, `${p}${k}.`) : [`${p}${k}`]));

test('every setting of the schema has exactly one entry in the list', () => {
  assert.deepEqual(SETTING_DEFS.map((d) => d.path).sort(), leaves(DEFAULT_SETTINGS).sort());
});

test('search matches label, path and description and keeps group order', () => {
  assert.deepEqual(searchSettings('').map((g) => g.group), ['Audio', 'Visual', 'Editor', 'Data']);
  assert.deepEqual(searchSettings('flash').flatMap((g) => g.items.map((i) => i.path)), ['visual.maxFlashesPerSecond']);
  assert.deepEqual(searchSettings('editor font').flatMap((g) => g.items.map((i) => i.path)), ['editor.fontSize']);
  assert.deepEqual(searchSettings('nothing matches this'), []);
});

test('getPath and setPath', () => {
  const s = setPath(DEFAULT_SETTINGS, 'audio.masterDb', -20);
  assert.equal(getPath(s, 'audio.masterDb'), -20);
  assert.equal(getPath(DEFAULT_SETTINGS, 'audio.masterDb'), -12, 'the input is not changed');
  assert.equal(getPath(s, 'nope.x'), undefined);
});

test('applySetting validates: safety values can only be made stricter', () => {
  const r = applySetting(DEFAULT_SETTINGS, 'visual.maxFlashesPerSecond', 10);
  assert.equal(r.settings.visual.maxFlashesPerSecond, 3);
  assert.equal(r.warnings[0].path, 'visual.maxFlashesPerSecond');
  const ok = applySetting(DEFAULT_SETTINGS, 'visual.maxFlashesPerSecond', 1);
  assert.equal(ok.settings.visual.maxFlashesPerSecond, 1);
  assert.deepEqual(ok.warnings, []);
});

test('settings.json round-trips and reports parse errors', () => {
  const text = settingsJson(DEFAULT_SETTINGS);
  const r = parseSettingsJson(text);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.settings, DEFAULT_SETTINGS);
  const bad = parseSettingsJson('{ "audio": ');
  assert.equal(bad.ok, false);
  const warn = parseSettingsJson('{ "audio": { "masterDb": -6, "maxMasterDb": -10 }, "x": 1 }');
  assert.equal(warn.ok && warn.settings.audio.masterDb, -10);
  assert.deepEqual(warn.ok && warn.warnings.map((w) => w.path).sort(), ['audio.masterDb', 'x']);
});
