// Status bar formatting (doc/ui.md, Status bar and States). Pure functions; the status bar
// component renders their output.

export const STATE_GLYPH = Object.freeze({ loading: '…', fresh: '●', stale: '◐', down: '○' });
export const STATE_LABEL = Object.freeze({ loading: 'connecting', fresh: 'fresh', stale: 'stale', down: 'down' });
export const MAX_VOICES = 64;

/**
 * HH:MM of an ISO time in an IANA zone; '' for null or an invalid time.
 * @param {string | null | undefined} iso
 * @param {string} [timeZone]
 */
export function formatHHMM(iso, timeZone = 'UTC') {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(d);
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

/**
 * Display data for one source's freshness.
 * @param {{ source: string, state: 'loading' | 'fresh' | 'stale' | 'down', lastRun: string | null, lastSuccess: string | null }} f
 * @param {string} [timeZone]
 * @returns {{ source: string, state: string, glyph: string, label: string, title: string }}
 */
export function freshnessItem(f, timeZone = 'UTC') {
  const state = Object.hasOwn(STATE_GLYPH, f.state) ? f.state : 'loading';
  const zone = timeZone === 'UTC' ? ' UTC' : '';
  let title;
  if (state === 'stale' || state === 'down') {
    const since = formatHHMM(f.lastSuccess ?? f.lastRun, timeZone);
    title = since ? `${f.source}: ${state} since ${since}${zone}` : `${f.source}: ${state}, no successful run`;
  } else if (state === 'loading') {
    title = `${f.source}: connecting`;
  } else {
    const at = formatHHMM(f.lastSuccess, timeZone);
    title = at ? `${f.source}: fresh, last success ${at}${zone}` : `${f.source}: fresh`;
  }
  return { source: f.source, state, glyph: STATE_GLYPH[state], label: STATE_LABEL[state], title };
}

/**
 * The sources the status bar shows: those of the followed groups, or every known source.
 * @param {{ source: string }[]} all freshness of every known source
 * @param {string[]} followedSources registry ids of the followed groups
 * @returns {any[]}
 */
export function statusSources(all, followedSources) {
  if (!followedSources.length) return all;
  const known = new Map(all.map((f) => [f.source, f]));
  return [...new Set(followedSources)].sort().map((s) => known.get(s) ?? { source: s, state: 'loading', lastRun: null, lastSuccess: null });
}

/** @typedef {'stopped' | 'starting' | 'playing' | 'muted' | 'fault'} AudioState */

/** @param {AudioState} state */
export function audioLabel(state) {
  switch (state) {
    case 'starting': return '… starting';
    case 'playing': return '▶ playing';
    case 'muted': return 'Muted';
    case 'fault': return 'Fault';
    default: return '■ stopped';
  }
}

/** @param {number} n */
export function voicesLabel(n) {
  const v = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  return `${v}/${MAX_VOICES}`;
}

/**
 * dBFS label of a linear peak; `−∞` at or below −100 dBFS.
 * @param {number | null} db
 */
export function levelLabel(db) {
  if (db === null || !Number.isFinite(db) || db <= -100) return '−∞ dBFS';
  return `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(0)} dBFS`;
}

/** @param {number} linear @returns {number} dBFS, -Infinity for 0 */
export function toDb(linear) {
  return linear > 0 ? 20 * Math.log10(linear) : -Infinity;
}

/** @param {number} db @returns {number} linear gain */
export function fromDb(db) {
  return Number.isFinite(db) ? Math.pow(10, db / 20) : 0;
}

/** @typedef {'saved' | 'saving' | 'unsaved' | 'offline' | 'scratch' | 'error'} SaveState */

/** @param {SaveState} s */
export function saveLabel(s) {
  switch (s) {
    case 'saving': return 'Saving…';
    case 'unsaved': return 'Unsaved changes';
    case 'offline': return 'Offline';
    case 'scratch': return 'Scratch';
    case 'error': return 'Save failed';
    default: return 'Saved';
  }
}

/**
 * Relative time for tables ("3 min ago"); '—' for null.
 * @param {string | number | null | undefined} t ISO string or ms
 * @param {number} nowMs
 */
export function relativeTime(t, nowMs) {
  if (t === null || t === undefined || t === '') return '—';
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}
