import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, reducedMotion, validateSettings } from '../src/lib/settings.js';

test('defaults round-trip without warnings', () => {
  const { settings, warnings } = validateSettings(structuredClone(DEFAULT_SETTINGS));
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.deepEqual(warnings, []);
});

test('unknown keys are dropped', () => {
  const { settings, warnings } = validateSettings({ extra: 1, audio: { masterDb: -20, bass: 11 } });
  assert.equal('extra' in settings, false);
  assert.equal('bass' in settings.audio, false);
  assert.equal(settings.audio.masterDb, -20);
  assert.deepEqual(warnings.map((w) => w.path).sort(), ['audio.bass', 'extra']);
});

test('looser safety values are rejected', () => {
  const { settings, warnings } = validateSettings({
    audio: { maxMasterDb: 6 },
    visual: { maxFlashesPerSecond: 10, reducedMotion: 'off' },
  });
  assert.equal(settings.audio.maxMasterDb, 0);
  assert.equal(settings.visual.maxFlashesPerSecond, 3);
  assert.equal(settings.visual.reducedMotion, 'system');
  assert.equal(warnings.length, 3);
});

test('stricter safety values are accepted', () => {
  const { settings } = validateSettings({ audio: { maxMasterDb: -18, masterDb: -24 }, visual: { maxFlashesPerSecond: 1, reducedMotion: 'on' } });
  assert.deepEqual([settings.audio.maxMasterDb, settings.audio.masterDb, settings.visual.maxFlashesPerSecond], [-18, -24, 1]);
  assert.equal(reducedMotion(settings, false), true);
});

test('masterDb above maxMasterDb is clamped', () => {
  const { settings } = validateSettings({ audio: { maxMasterDb: -18, masterDb: -6 } });
  assert.equal(settings.audio.masterDb, -18);
});

test('the OS reduced-motion preference cannot be overridden', () => {
  assert.equal(reducedMotion(DEFAULT_SETTINGS, true), true);
  assert.equal(reducedMotion(DEFAULT_SETTINGS, false), false);
});

test('enumerations, ranges and the time zone are checked', () => {
  const { settings, warnings } = validateSettings({
    editor: { fontSize: 40, theme: 'neon' },
    data: { replaySpeed: 50, timeZone: 'America/Chicago', observer: { lat: 100, lon: 0 } },
  });
  assert.equal(settings.editor.fontSize, 14);
  assert.equal(settings.editor.theme, 'dark');
  assert.equal(settings.data.replaySpeed, 100);
  assert.equal(settings.data.timeZone, 'America/Chicago');
  assert.deepEqual(settings.data.observer, DEFAULT_SETTINGS.data.observer);
  assert.equal(warnings.length, 4);
});
