// Command palette commands and fuzzy filtering (doc/ui.md, Command palette).

/**
 * @typedef {{ id: string, title: string, shortcut?: string, needs?: 'piece' | 'project' | 'signedIn' }} CommandDef
 * `needs`: `piece` (a piece is loaded), `project` (a saved project is open), `signedIn`.
 */

/** @type {readonly CommandDef[]} */
export const COMMANDS = Object.freeze([
  { id: 'run', title: 'Run', shortcut: 'Mod-Enter', needs: 'piece' },
  { id: 'stop', title: 'Stop', shortcut: 'Mod-.', needs: 'piece' },
  { id: 'panic', title: 'Panic', needs: 'piece' },
  { id: 'save', title: 'Save', shortcut: 'Mod-s', needs: 'piece' },
  { id: 'new-project', title: 'New Project', needs: 'signedIn' },
  { id: 'open-project', title: 'Open Project', needs: 'signedIn' },
  { id: 'toggle-console', title: 'Toggle Console', needs: 'piece' },
  { id: 'toggle-problems', title: 'Toggle Problems', needs: 'piece' },
  { id: 'toggle-ir', title: 'Toggle IR', needs: 'piece' },
  { id: 'toggle-trace', title: 'Toggle Trace', needs: 'piece' },
  { id: 'toggle-side', title: 'Toggle Side Panel', shortcut: 'Mod-b', needs: 'piece' },
  { id: 'toggle-preview', title: 'Toggle Preview', shortcut: 'Mod-Alt-b', needs: 'piece' },
  { id: 'toggle-bottom', title: 'Toggle Bottom Panel', shortcut: 'Mod-j', needs: 'piece' },
  { id: 'replay', title: 'Replay', needs: 'piece' },
  { id: 'go-live', title: 'Go Live', needs: 'piece' },
  { id: 'download-trace', title: 'Download Trace' },
  { id: 'open-settings', title: 'Open Settings', needs: 'signedIn' },
  { id: 'open-guide', title: 'Open Guide' },
  { id: 'run-fullscreen', title: 'Run Fullscreen', needs: 'project' },
]);

/**
 * Commands available in a context.
 * @param {readonly CommandDef[]} commands
 * @param {{ piece?: boolean, project?: boolean, signedIn?: boolean }} ctx
 */
export function availableCommands(commands, ctx) {
  return commands.filter((c) => !c.needs || ctx[c.needs] === true);
}

/**
 * Fuzzy score of `query` against `text`: every query character must appear in order. Higher is
 * better; null when it does not match. Consecutive characters, word starts and an early first
 * match score higher.
 * @param {string} text @param {string} query
 * @returns {number | null}
 */
export function fuzzyScore(text, query) {
  const t = text.toLowerCase();
  const q = query.toLowerCase().replace(/\s+/g, ' ').trim();
  if (q === '') return 0;
  let score = 0;
  let ti = 0;
  let prev = -2;
  let first = -1;
  for (const ch of q) {
    if (ch === ' ') continue;
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    if (first < 0) first = i;
    const wordStart = i === 0 || /[\s\-_/.:]/.test(t[i - 1]);
    score += 1;
    if (i === prev + 1) score += 5;
    if (wordStart) score += 8;
    prev = i;
    ti = i + 1;
  }
  score -= first * 0.5;
  score -= (t.length - q.length) * 0.05;
  if (t.startsWith(q)) score += 20;
  return score;
}

/**
 * Items matching `query`, best first; ties keep input order. `key` selects the text to match.
 * @template T
 * @param {readonly T[]} items @param {string} query @param {(item: T) => string} key
 * @returns {T[]}
 */
export function fuzzyFilter(items, query, key) {
  const scored = [];
  items.forEach((item, i) => {
    const s = fuzzyScore(key(item), query);
    if (s !== null) scored.push({ item, s, i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.map((x) => x.item);
}

/**
 * @param {readonly CommandDef[]} commands @param {string} query
 */
export function filterCommands(commands, query) {
  return fuzzyFilter(commands, query, (c) => c.title);
}
