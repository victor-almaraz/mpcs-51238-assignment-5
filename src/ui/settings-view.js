// Settings screen model (doc/ui.md, Settings and Settings schema): the grouped, searchable list
// and the settings.json view. Both edit one object validated with validateSettings.

import { validateSettings } from '../lib/settings.js';

/**
 * @typedef {{ path: string, group: string, label: string, description: string,
 *   control: 'number' | 'select' | 'text' | 'observer', min?: number, max?: number, step?: number,
 *   options?: (string | number)[] }} SettingDef
 */

/** @type {readonly SettingDef[]} */
export const SETTING_DEFS = Object.freeze([
  { path: 'audio.masterDb', group: 'Audio', label: 'Master volume', description: 'Starting master level in dB; clamped to the maximum.', control: 'number', min: -60, max: 0, step: 1 },
  { path: 'audio.maxMasterDb', group: 'Audio', label: 'Maximum master volume', description: 'Upper limit of the master level in dB. Cannot exceed the engine maximum of 0 dB.', control: 'number', min: -60, max: 0, step: 1 },
  { path: 'visual.reducedMotion', group: 'Visual', label: 'Reduced motion', description: 'system follows the OS setting; on always reduces motion. The OS setting can only be made stricter.', control: 'select', options: ['system', 'on'] },
  { path: 'visual.maxFlashesPerSecond', group: 'Visual', label: 'Maximum flashes per second', description: 'Flash limit of the renderer, 0 to 3. Cannot exceed 3.', control: 'number', min: 0, max: 3, step: 1 },
  { path: 'visual.previewScale', group: 'Visual', label: 'Preview resolution', description: 'Editor preview resolution as a fraction of the display, 0.25 to 1.', control: 'number', min: 0.25, max: 1, step: 0.05 },
  { path: 'editor.fontSize', group: 'Editor', label: 'Font size', description: 'Editor font size in px, 10 to 24.', control: 'number', min: 10, max: 24, step: 1 },
  { path: 'editor.theme', group: 'Editor', label: 'Theme', description: 'Colour theme of the app.', control: 'select', options: ['dark', 'light'] },
  { path: 'editor.keymap', group: 'Editor', label: 'Keymap', description: 'Editor key bindings.', control: 'select', options: ['default', 'vim'] },
  { path: 'data.replaySpeed', group: 'Data', label: 'Replay speed', description: 'Default speed of Replay.', control: 'select', options: [1, 10, 100, 1000] },
  { path: 'data.consoleBuffer', group: 'Data', label: 'Console buffer', description: 'Trace records kept in the console, 500 to 5000.', control: 'number', min: 500, max: 5000, step: 100 },
  { path: 'data.timeZone', group: 'Data', label: 'Time zone', description: 'IANA zone used to display times. Stored times are UTC.', control: 'text' },
  { path: 'data.observer', group: 'Data', label: 'Observer', description: 'Latitude and longitude in degrees, used by the sky projection and the elevation orbit quantity.', control: 'observer' },
]);

export const SETTING_GROUPS = Object.freeze(['Audio', 'Visual', 'Editor', 'Data']);

/**
 * Settings matching a search, grouped in display order. Matches label, path and description.
 * @param {string} query
 * @returns {{ group: string, items: SettingDef[] }[]}
 */
export function searchSettings(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (/** @type {SettingDef} */ d) => {
    const text = `${d.label} ${d.path} ${d.description} ${d.group}`.toLowerCase();
    return words.every((w) => text.includes(w));
  };
  return SETTING_GROUPS
    .map((group) => ({ group, items: SETTING_DEFS.filter((d) => d.group === group && hit(d)) }))
    .filter((g) => g.items.length > 0);
}

/** @param {any} obj @param {string} path */
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

/**
 * Copy of `obj` with `path` set to `value`.
 * @param {any} obj @param {string} path @param {unknown} value
 */
export function setPath(obj, path, value) {
  const keys = path.split('.');
  const out = structuredClone(obj ?? {});
  let o = out;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[/** @type {string} */ (keys.at(-1))] = value;
  return out;
}

/**
 * Parses the settings.json text. A parse error keeps the text local and reports the error.
 * @param {string} text
 * @returns {{ ok: true, settings: any, warnings: { path: string, message: string }[] } | { ok: false, error: string }}
 */
export function parseSettingsJson(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const { settings, warnings } = validateSettings(raw);
  return { ok: true, settings, warnings };
}

/** @param {any} settings */
export function settingsJson(settings) {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * Applies one control change and validates the result.
 * @param {any} settings @param {string} path @param {unknown} value
 */
export function applySetting(settings, path, value) {
  return validateSettings(setPath(settings, path, value));
}
