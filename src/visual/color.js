/**
 * Colour helpers: hex parsing, sRGB transfer, relative luminance and
 * CIE 1976 UCS chromaticity (doc/visuals.md, Visual safety).
 */

const HEX = /^#([0-9a-f]{6})$/i;

/**
 * @param {unknown} s
 * @returns {boolean}
 */
export function isHexColor(s) {
  return typeof s === 'string' && HEX.test(s);
}

/**
 * Parses `#rrggbb` into sRGB components 0–1.
 * @param {string} hex
 * @returns {[number, number, number] | null}
 */
export function parseHex(hex) {
  const m = typeof hex === 'string' ? HEX.exec(hex) : null;
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * @param {number} c sRGB component 0–1
 * @returns {number} linear component 0–1
 */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * @param {number} c linear component 0–1
 * @returns {number} sRGB component 0–1
 */
export function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/**
 * Relative luminance of linear RGB (ITU-R BT.709 / sRGB primaries).
 * @param {number} r @param {number} g @param {number} b linear 0–1
 */
export function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** D65 white point in u′v′. */
export const WHITE_UV = Object.freeze([0.19784, 0.46832]);

/**
 * CIE 1976 UCS chromaticity u′v′ of linear sRGB. Black returns the D65
 * white point.
 * @param {number} r @param {number} g @param {number} b linear 0–1
 * @returns {[number, number]}
 */
export function chromaticityUV(r, g, b) {
  const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const d = X + 15 * Y + 3 * Z;
  if (d < 1e-6) return [WHITE_UV[0], WHITE_UV[1]];
  return [(4 * X) / d, (9 * Y) / d];
}

/**
 * Red ratio R/(R+G+B) of linear RGB; 0 for black.
 * @param {number} r @param {number} g @param {number} b
 */
export function redRatio(r, g, b) {
  const s = r + g + b;
  return s > 1e-6 ? r / s : 0;
}

/**
 * Linear blend of two sRGB triples.
 * @param {number[]} a @param {number[]} b @param {number} t 0–1
 * @returns {[number, number, number]}
 */
export function mixRgb(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Colormap stops (0, 0.5, 1), sRGB hex. */
export const COLORMAPS = Object.freeze({
  night: Object.freeze(['#05070c', '#1b2a4a', '#6c7fb8']),
  ember: Object.freeze(['#0b0503', '#7a1e0a', '#f2a541']),
  ice: Object.freeze(['#04080c', '#1f6f8b', '#d6f3ff']),
});

/**
 * Samples a colormap at t (clamped to 0–1).
 * @param {keyof typeof COLORMAPS} name
 * @param {number} t
 * @returns {[number, number, number]} sRGB 0–1
 */
export function sampleColormap(name, t) {
  const stops = (COLORMAPS[name] ?? COLORMAPS.night).map((h) => /** @type {number[]} */ (parseHex(h)));
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * 2;
  const i = Math.min(1, Math.floor(x));
  return mixRgb(stops[i], stops[i + 1], x - i);
}
