import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LAYOUT, LAYOUT_KEY, loadLayout, saveLayout } from '../src/ui/layout.js';
import { SHORTCUTS } from '../src/ui/shortcuts.js';

const memory = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, v); } };
};

test('layout defaults to every part shown', () => {
  assert.deepEqual(loadLayout(null), { side: true, preview: true, panel: true });
  assert.deepEqual(loadLayout(memory()), DEFAULT_LAYOUT);
});

test('layout round-trips through storage', () => {
  const s = memory();
  saveLayout(s, { side: false, preview: true, panel: false });
  assert.deepEqual(loadLayout(s), { side: false, preview: true, panel: false });
});

test('malformed stored layouts fall back field by field', () => {
  assert.deepEqual(loadLayout(memory({ [LAYOUT_KEY]: '{not json' })), DEFAULT_LAYOUT);
  assert.deepEqual(loadLayout(memory({ [LAYOUT_KEY]: '{"side":"no","preview":false}' })), { side: true, preview: false, panel: true });
});

test('storage errors do not throw', () => {
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
  assert.deepEqual(loadLayout(broken), DEFAULT_LAYOUT);
  assert.doesNotThrow(() => saveLayout(broken, DEFAULT_LAYOUT));
});

test('layout shortcuts of doc/ui.md', () => {
  assert.deepEqual(SHORTCUTS.toggleSide, ['Mod-b']);
  assert.deepEqual(SHORTCUTS.togglePreview, ['Mod-Alt-b']);
  assert.deepEqual(SHORTCUTS.togglePanel, ['Mod-j']);
});
