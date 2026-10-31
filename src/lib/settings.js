// User settings schema and validation (doc/ui.md, Settings schema).
// Safety values can only be made stricter than the defaults allow.

export const ENGINE_MAX_MASTER_DB = 0;
export const MAX_FLASHES_PER_SECOND = 3;

export const DEFAULT_SETTINGS = Object.freeze({
  audio: { masterDb: -12, maxMasterDb: 0 },
  visual: { reducedMotion: 'system', maxFlashesPerSecond: 3, previewScale: 0.5 },
  editor: { fontSize: 14, theme: 'dark', keymap: 'default' },
  data: { replaySpeed: 100, consoleBuffer: 2000, timeZone: 'UTC', observer: { lat: 41.79, lon: -87.6 } },
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const range = (min, max) => (v) => (isNum(v) && v >= min && v <= max ? null : `must be a number from ${min} to ${max}`);
const oneOf = (...vals) => (v) => (vals.includes(v) ? null : `must be one of ${vals.join(', ')}`);
const isZone = (v) => {
  if (typeof v !== 'string' || v === '') return 'must be an IANA time zone name';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return null;
  } catch {
    return 'must be an IANA time zone name';
  }
};

/** Rules per leaf key. `ctx` is the partially validated result (for cross-key rules). */
const RULES = {
  audio: {
    maxMasterDb: () => range(-60, ENGINE_MAX_MASTER_DB),
    masterDb: (ctx) => range(-60, ctx.audio.maxMasterDb),
  },
  visual: {
    reducedMotion: () => oneOf('system', 'on'),
    maxFlashesPerSecond: () => range(0, MAX_FLASHES_PER_SECOND),
    previewScale: () => range(0.25, 1),
  },
  editor: {
    fontSize: () => range(10, 24),
    theme: () => oneOf('dark', 'light'),
    keymap: () => oneOf('default', 'vim'),
  },
  data: {
    replaySpeed: () => oneOf(1, 10, 100, 1000),
    consoleBuffer: () => range(500, 5000),
    timeZone: () => isZone,
    observer: () => (v) => (v && typeof v === 'object' && range(-90, 90)(v.lat) === null && range(-180, 180)(v.lon) === null
      ? null : 'must be { lat: -90..90, lon: -180..180 }'),
  },
};

/**
 * Validate a settings object. Unknown keys are dropped; invalid values fall back to defaults.
 * `audio.masterDb` above `maxMasterDb` is clamped rather than reset.
 * @returns {{ settings: object, warnings: { path: string, message: string }[] }}
 */
export function validateSettings(input) {
  const warnings = [];
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (src !== input && input !== undefined) warnings.push({ path: '', message: 'settings must be an object' });
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const key of Object.keys(src)) {
    if (!Object.hasOwn(RULES, key)) warnings.push({ path: key, message: 'unknown key dropped' });
  }
  for (const [section, rules] of Object.entries(RULES)) {
    const given = src[section];
    if (given === undefined) continue;
    if (!given || typeof given !== 'object' || Array.isArray(given)) {
      warnings.push({ path: section, message: 'must be an object; defaults used' });
      continue;
    }
    for (const key of Object.keys(given)) {
      if (!Object.hasOwn(rules, key)) warnings.push({ path: `${section}.${key}`, message: 'unknown key dropped' });
    }
    for (const [key, rule] of Object.entries(rules)) {
      if (!(key in given)) continue;
      const value = given[key];
      if (section === 'audio' && key === 'masterDb' && isNum(value) && value > out.audio.maxMasterDb && value <= ENGINE_MAX_MASTER_DB) {
        out.audio.masterDb = out.audio.maxMasterDb;
        warnings.push({ path: 'audio.masterDb', message: `clamped to maxMasterDb ${out.audio.maxMasterDb}` });
        continue;
      }
      const problem = rule(out)(value);
      if (problem) warnings.push({ path: `${section}.${key}`, message: `${problem}; default used` });
      else out[section][key] = key === 'observer' ? { lat: value.lat, lon: value.lon } : value;
    }
  }
  if (out.audio.masterDb > out.audio.maxMasterDb) out.audio.masterDb = out.audio.maxMasterDb;
  return { settings: out, warnings };
}

/** Effective reduced-motion flag: the OS preference can only be made stricter. */
export function reducedMotion(settings, systemPrefersReduced) {
  return settings.visual.reducedMotion === 'on' || systemPrefersReduced === true;
}

/** localStorage key of the last known safety limits (doc/ui.md, Settings schema). */
export const SAFETY_CACHE_KEY = 'sphaerenmusik.safety';

/** The safety limits of validated settings, for the local copy. */
export function safetyLimits(settings) {
  return {
    masterDb: settings.audio.masterDb,
    maxMasterDb: settings.audio.maxMasterDb,
    maxFlashesPerSecond: settings.visual.maxFlashesPerSecond,
    reducedMotion: settings.visual.reducedMotion,
  };
}

/**
 * `settings` with each safety limit set to the stricter of its value and the stored copy.
 * An invalid copy changes nothing.
 * @param {typeof DEFAULT_SETTINGS} settings validated settings
 * @param {unknown} cached parsed safetyLimits() output
 */
export function stricterSafety(settings, cached) {
  const out = structuredClone(settings);
  if (!cached || typeof cached !== 'object') return out;
  const c = /** @type {any} */ (cached);
  const v = validateSettings({
    audio: { maxMasterDb: c.maxMasterDb, masterDb: c.masterDb },
    visual: { maxFlashesPerSecond: c.maxFlashesPerSecond, reducedMotion: c.reducedMotion },
  }).settings;
  if (isNum(c.maxMasterDb)) out.audio.maxMasterDb = Math.min(out.audio.maxMasterDb, v.audio.maxMasterDb);
  if (isNum(c.masterDb)) out.audio.masterDb = Math.min(out.audio.masterDb, v.audio.masterDb);
  out.audio.masterDb = Math.min(out.audio.masterDb, out.audio.maxMasterDb);
  if (isNum(c.maxFlashesPerSecond)) out.visual.maxFlashesPerSecond = Math.min(out.visual.maxFlashesPerSecond, v.visual.maxFlashesPerSecond);
  if (c.reducedMotion === 'on') out.visual.reducedMotion = 'on';
  return out;
}
