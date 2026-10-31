import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// doc/ui.md, Style, Colour: every text token keeps WCAG AA (4.5:1) on each surface of its theme.
const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
const block = (selector) => {
  const body = css.slice(css.indexOf(`${selector} {`)).match(/\{([^}]*)\}/)[1];
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]));
};
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const TEXT = ['fg', 'fg-muted', 'accent', 'ok', 'warn', 'error', 'syn-keyword', 'syn-string', 'syn-number', 'syn-function', 'syn-type'];
const SURFACES = ['bg', 'panel', 'panel-2'];

for (const [name, selector, extra] of [['dark', ':root, [data-theme="dark"]', ['#000000']], ['light', ':root[data-theme="light"]', []]]) {
  test(`${name} theme: text tokens reach 4.5:1 on every surface`, () => {
    const t = block(selector);
    for (const k of [...TEXT, ...SURFACES]) assert.ok(t[k], `--${k} is missing`);
    for (const fg of TEXT) {
      for (const bg of [...SURFACES.map((s) => t[s]), ...extra]) {
        assert.ok(ratio(t[fg], bg) >= 4.5, `--${fg} on ${bg}: ${ratio(t[fg], bg).toFixed(2)}`);
      }
    }
    assert.ok(ratio(t.bg, t.accent) >= 4.5, 'text on the accent button');
  });
}
