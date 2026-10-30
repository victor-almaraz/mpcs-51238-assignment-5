import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHORTCUTS, createDoublePress, formatShortcut, isMacPlatform, matchShortcut, parseShortcut, shortcutFor } from '../src/ui/shortcuts.js';

const ev = (key, o = {}) => ({ key, code: o.code, ctrlKey: !!o.ctrl, metaKey: !!o.meta, altKey: !!o.alt, shiftKey: !!o.shift });

test('parseShortcut reads modifiers and the key', () => {
  assert.deepEqual(parseShortcut('Mod-Shift-P'), { key: 'p', mod: true, ctrl: false, alt: false, shift: true, meta: false });
  assert.equal(parseShortcut('Mod-.').key, '.');
  assert.equal(parseShortcut('Mod--').key, '-');
  assert.equal(parseShortcut('F1').key, 'f1');
  assert.equal(parseShortcut('Esc').key, 'escape');
  assert.throws(() => parseShortcut('Hyper-K'), /unknown modifier/);
  assert.throws(() => parseShortcut(''), TypeError);
});

test('Mod is Cmd on macOS and Ctrl elsewhere', () => {
  assert.equal(matchShortcut(ev('k', { meta: true }), 'Mod-k', true), true);
  assert.equal(matchShortcut(ev('k', { ctrl: true }), 'Mod-k', true), false);
  assert.equal(matchShortcut(ev('k', { ctrl: true }), 'Mod-k', false), true);
  assert.equal(matchShortcut(ev('k', { meta: true }), 'Mod-k', false), false);
});

test('extra or missing modifiers do not match', () => {
  assert.equal(matchShortcut(ev('P', { meta: true, shift: true }), 'Mod-Shift-p', true), true);
  assert.equal(matchShortcut(ev('p', { meta: true }), 'Mod-Shift-p', true), false);
  assert.equal(matchShortcut(ev('Enter', { ctrl: true, alt: true }), 'Mod-Enter', false), false);
});

test('digits match through code with shift layouts', () => {
  assert.equal(matchShortcut(ev('!', { ctrl: true, shift: true, code: 'Digit1' }), 'Mod-1', false), false, 'shift must match');
  assert.equal(matchShortcut(ev('&', { ctrl: true, code: 'Digit1' }), 'Mod-1', false), true);
});

test('shortcutFor finds the action in the table', () => {
  assert.equal(shortcutFor(ev('Enter', { meta: true }), SHORTCUTS, true), 'run');
  assert.equal(shortcutFor(ev('.', { ctrl: true }), SHORTCUTS, false), 'stop');
  assert.equal(shortcutFor(ev('K', { meta: true }), SHORTCUTS, true), 'palette');
  assert.equal(shortcutFor(ev('F1'), SHORTCUTS, true), 'reference');
  assert.equal(shortcutFor(ev('x'), SHORTCUTS, true), null);
});

test('formatShortcut', () => {
  assert.equal(formatShortcut('Mod-Shift-p', true), '⇧⌘P');
  assert.equal(formatShortcut('Mod-Shift-p', false), 'Ctrl+Shift+P');
  assert.equal(formatShortcut('Mod-Enter', true), '⌘↩');
});

test('isMacPlatform', () => {
  assert.equal(isMacPlatform({ platform: 'MacIntel' }), true);
  assert.equal(isMacPlatform({ platform: 'Win32', userAgent: 'Windows' }), false);
  assert.equal(isMacPlatform(undefined), false);
});

test('Escape twice within 500 ms is a panic', () => {
  const d = createDoublePress(500);
  assert.equal(d.press(0), false);
  assert.equal(d.press(400), true);
  assert.equal(d.press(450), false, 'a third press starts over');
  assert.equal(d.press(1200), false);
  assert.equal(d.press(1700), true);
});
