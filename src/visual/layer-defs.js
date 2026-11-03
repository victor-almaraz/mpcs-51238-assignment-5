/**
 * Layer types and their properties: the single source of truth for layer
 * validation, clamping, editor completion and the guide's property table
 * (doc/visuals.md, Layer properties).
 *
 * Shape:
 *   LAYER_DEFS[type] = {
 *     group: boolean,        // the constructor takes a group as first argument
 *     localOnly: boolean,    // a piece using the layer cannot be shared
 *     props: { [name]: PropDef },
 *   }
 *   PropDef =
 *     | { type: 'number', min, max, default, unit?, reducedMotion? }
 *     | { type: 'color',  default }            // '#rrggbb'
 *     | { type: 'char',   default }            // one character
 *     | { type: 'enum',   options, default }
 *     | { type: 'colors', max, default }       // list of '#rrggbb', at most `max`; constant or set from a handler
 *     | { type: 'numbers', min, max, length, default } // list of numbers in [min, max], at most `length`; likewise
 *
 * `unit` is 'px', 's' or 'min'. `reducedMotion` is the value forced while
 * reduced motion is active.
 *
 * @typedef {{ type: 'number', min: number, max: number, default: number, unit?: string, reducedMotion?: number }
 *   | { type: 'color', default: string }
 *   | { type: 'char', default: string }
 *   | { type: 'enum', options: readonly string[], default: string }
 *   | { type: 'colors', max: number, default: readonly string[] }
 *   | { type: 'numbers', min: number, max: number, length: number, default: readonly number[] }} PropDef
 * @typedef {{ group: boolean, localOnly: boolean, props: Record<string, PropDef> }} LayerDef
 */

/** @type {PropDef} */
const opacity = { type: 'number', min: 0, max: 1, default: 1 };
const white = '#ffffff';

/** @type {Readonly<Record<string, LayerDef>>} */
export const LAYER_DEFS = deepFreeze({
  points: {
    group: true,
    localOnly: false,
    props: {
      opacity,
      size: { type: 'number', min: 0.5, max: 24, default: 2, unit: 'px' },
      color: { type: 'color', default: white },
      trail: { type: 'number', min: 0, max: 3600, default: 0, unit: 's', reducedMotion: 0 },
    },
  },
  rings: {
    group: true,
    localOnly: false,
    props: {
      opacity,
      radius: { type: 'number', min: 1, max: 800, default: 20, unit: 'px' },
      width: { type: 'number', min: 0.5, max: 8, default: 1, unit: 'px' },
      color: { type: 'color', default: white },
    },
  },
  lines: {
    group: true,
    localOnly: false,
    props: {
      opacity,
      span: { type: 'number', min: 1, max: 200, default: 90, unit: 'min' },
      color: { type: 'color', default: white },
    },
  },
  glyph: {
    group: true,
    localOnly: false,
    props: {
      opacity,
      char: { type: 'char', default: '+' },
      size: { type: 'number', min: 6, max: 48, default: 12, unit: 'px' },
      color: { type: 'color', default: white },
      fade: { type: 'number', min: 0, max: 60, default: 0, unit: 's', reducedMotion: 0 },
    },
  },
  field: {
    group: false,
    localOnly: false,
    props: {
      opacity,
      value: { type: 'number', min: 0, max: 1, default: 0 },
      colormap: { type: 'enum', options: ['night', 'ember', 'ice'], default: 'night' },
    },
  },
  aurora: {
    group: false,
    localOnly: false,
    props: {
      opacity,
      intensity: { type: 'number', min: 0, max: 1, default: 0 },
      drift: { type: 'number', min: 0, max: 1, default: 0.2, reducedMotion: 0 },
    },
  },
  grid: {
    group: false,
    localOnly: false,
    props: {
      opacity,
      cols: { type: 'number', min: 1, max: 32, default: 16 },
      rows: { type: 'number', min: 1, max: 32, default: 16 },
      gap: { type: 'number', min: 0, max: 8, default: 2, unit: 'px' },
      background: { type: 'color', default: '#000000' },
      cells: { type: 'colors', max: 1024, default: [] },
      sizes: { type: 'numbers', min: 0, max: 1, length: 1024, default: [] },
      shape: { type: 'enum', options: ['square', 'circle'], default: 'square' },
    },
  },
  shader: {
    group: false,
    localOnly: true,
    props: { opacity },
  },
});

/** Layer types in declaration order. */
export const LAYER_TYPES = Object.freeze(Object.keys(LAYER_DEFS));

/**
 * @template T
 * @param {T} o
 * @returns {T}
 */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
