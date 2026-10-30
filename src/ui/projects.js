// Projects screen logic (doc/ui.md, Projects and Starter projects). Pure helpers; the page and
// the client component do the I/O.

export const UNDO_MS = 10000;
export const NAME_MAX = 120;
export const LAST_RUN_PREFIX = 'sphaerenmusik.lastRun.';

export const BLANK_SOURCE = `// A blank piece. Follow a group, give it an instrument, and press Run.
// Guide: /learn/first-piece

`;

/**
 * @typedef {{ version: number, starters: { slug: string, name: string }[] }} Manifest
 * @typedef {{ slug: string, name: string, source: string, ir: any }} Starter
 */

/**
 * Validates the starter manifest (content/starters/manifest.json).
 * @param {unknown} m
 * @returns {Manifest}
 */
export function checkManifest(m) {
  const v = /** @type {any} */ (m);
  if (!v || !Number.isInteger(v.version) || v.version < 1 || !Array.isArray(v.starters)) {
    throw new Error('content/starters/manifest.json needs an integer version and a starters array');
  }
  for (const s of v.starters) {
    if (!s || typeof s.slug !== 'string' || !/^[a-z0-9-]+$/.test(s.slug) || typeof s.name !== 'string' || s.name === '') {
      throw new Error(`content/starters/manifest.json: invalid starter ${JSON.stringify(s)}`);
    }
  }
  return v;
}

/** True when the account has not received the manifest's starters. */
export function needsSeeding(/** @type {number | null | undefined} */ startersVersion, /** @type {number} */ manifestVersion) {
  return !(Number.isInteger(startersVersion) && /** @type {number} */ (startersVersion) >= manifestVersion);
}

/**
 * The `p_projects` argument of `seed_starters`.
 * @param {Starter[]} starters
 */
export function seedPayload(starters) {
  return starters.map((s) => ({ slug: s.slug, name: s.name, source: s.source, ir: s.ir }));
}

/**
 * Name of a copy: `Name (copy)`, then `Name (copy 2)`, … unique among `existing`, at most 120
 * characters.
 * @param {string} name @param {readonly string[]} existing
 */
export function duplicateName(name, existing) {
  const base = name.replace(/ \(copy(?: \d+)?\)$/, '');
  const taken = new Set(existing);
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' (copy)' : ` (copy ${n})`;
    const candidate = `${base.slice(0, NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A new project's name: `Untitled`, `Untitled 2`, … or the template name.
 * @param {string} base @param {readonly string[]} existing
 */
export function uniqueName(base, existing) {
  const taken = new Set(existing);
  const b = base.slice(0, NAME_MAX - 4) || 'Untitled';
  if (!taken.has(b)) return b;
  for (let n = 2; ; n++) if (!taken.has(`${b} ${n}`)) return `${b} ${n}`;
}

/** @param {unknown} name @returns {string | null} an error, or null when valid */
export function nameError(name) {
  if (typeof name !== 'string' || name.trim() === '') return 'Name cannot be empty';
  if (name.length > NAME_MAX) return `Name is longer than ${NAME_MAX} characters`;
  return null;
}

/**
 * Last-run times per browser (`projects` has no last-run column; doc/ui.md, Projects).
 * @param {{ getItem(k: string): string | null, setItem(k: string, v: string): void } | null} storage
 */
export function createLastRunStore(storage) {
  return {
    /** @param {string} id @returns {number | null} */
    get(id) {
      try {
        const v = Number(storage?.getItem(LAST_RUN_PREFIX + id));
        return Number.isFinite(v) && v > 0 ? v : null;
      } catch { return null; }
    },
    /** @param {string} id @param {number} ms */
    set(id, ms) {
      try { storage?.setItem(LAST_RUN_PREFIX + id, String(ms)); } catch { /* storage full or blocked */ }
    },
  };
}

/**
 * Rows of the projects table from `projects` rows with embedded `project_subscriptions`.
 * @param {any[]} rows
 */
export function projectRows(rows) {
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ''),
    updatedAt: r.updated_at ?? null,
    starterSlug: r.starter_slug ?? null,
    groups: (Array.isArray(r.project_subscriptions) ? r.project_subscriptions.map((s) => s.group_key) : []).sort(),
  }));
}
