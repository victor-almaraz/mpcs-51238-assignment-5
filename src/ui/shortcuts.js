// Keyboard shortcuts (doc/ui.md, Keyboard shortcuts). Specs use CodeMirror's notation:
// modifiers `Mod`, `Ctrl`, `Alt`, `Shift`, `Meta` joined by `-`, then the key, for example
// `Mod-Shift-P`. `Mod` is Cmd on macOS and Ctrl elsewhere.

export const SHORTCUTS = Object.freeze({
  run: ['Mod-Enter'],
  stop: ['Mod-.'],
  save: ['Mod-s'],
  palette: ['Mod-Shift-p', 'Mod-k'],
  toggleSide: ['Mod-b'],
  togglePreview: ['Mod-Alt-b'],
  togglePanel: ['Mod-j'],
  focusEditor: ['Mod-1'],
  focusPreview: ['Mod-2'],
  reference: ['F1'],
});

export const PANIC_WINDOW_MS = 500;

/**
 * @typedef {{ key: string, mod: boolean, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean }} Shortcut
 */

/**
 * Parses a spec such as `Mod-Shift-P`. Throws on an unknown modifier or an empty key.
 * @param {string} spec
 * @returns {Shortcut}
 */
export function parseShortcut(spec) {
  if (typeof spec !== 'string' || spec === '') throw new TypeError('shortcut spec must be a non-empty string');
  // `Mod--` is the minus key: split on '-' that follows a modifier.
  const parts = spec.split(/-(?!$)/);
  const key = parts.pop();
  if (!key) throw new TypeError(`shortcut ${spec} has no key`);
  const out = { key: normalizeKey(key), mod: false, ctrl: false, alt: false, shift: false, meta: false };
  for (const p of parts) {
    const m = p.toLowerCase();
    if (m === 'mod') out.mod = true;
    else if (m === 'ctrl' || m === 'control') out.ctrl = true;
    else if (m === 'alt' || m === 'option') out.alt = true;
    else if (m === 'shift') out.shift = true;
    else if (m === 'meta' || m === 'cmd') out.meta = true;
    else throw new TypeError(`shortcut ${spec}: unknown modifier ${p}`);
  }
  return out;
}

/** @param {string} key */
function normalizeKey(key) {
  if (key.length === 1) return key.toLowerCase();
  const k = key.toLowerCase();
  if (k === 'esc') return 'escape';
  if (k === 'return') return 'enter';
  if (k === 'space') return ' ';
  return k;
}

/**
 * True when a keyboard event matches the shortcut.
 * @param {{ key: string, code?: string, ctrlKey: boolean, metaKey: boolean, altKey: boolean, shiftKey: boolean }} e
 * @param {Shortcut | string} shortcut
 * @param {boolean} isMac
 */
export function matchShortcut(e, shortcut, isMac) {
  const s = typeof shortcut === 'string' ? parseShortcut(shortcut) : shortcut;
  const wantCtrl = s.ctrl || (s.mod && !isMac);
  const wantMeta = s.meta || (s.mod && isMac);
  if (!!e.ctrlKey !== wantCtrl || !!e.metaKey !== wantMeta || !!e.altKey !== s.alt) return false;
  // Shift changes the produced character (`Shift-.` gives `>`); compare letters case-insensitively
  // and digits through `code` so `Mod-Shift-1` still matches.
  if (!!e.shiftKey !== s.shift) return false;
  const key = normalizeKey(e.key ?? '');
  if (key === s.key) return true;
  if (e.code && /^Digit\d$/.test(e.code) && e.code.slice(5) === s.key) return true;
  if (e.code && /^Key[A-Z]$/.test(e.code) && e.code.slice(3).toLowerCase() === s.key) return true;
  return false;
}

/**
 * Name of the first shortcut in `table` matching the event, or null.
 * @param {any} e @param {Record<string, readonly string[]>} table @param {boolean} isMac
 * @returns {string | null}
 */
export function shortcutFor(e, table, isMac) {
  for (const [name, specs] of Object.entries(table)) {
    if (specs.some((spec) => matchShortcut(e, spec, isMac))) return name;
  }
  return null;
}

/**
 * Display form: `⌘⇧P` on macOS, `Ctrl+Shift+P` elsewhere.
 * @param {string} spec @param {boolean} isMac
 */
export function formatShortcut(spec, isMac) {
  const s = parseShortcut(spec);
  const key = s.key === ' ' ? 'Space' : s.key.length === 1 ? s.key.toUpperCase() : s.key[0].toUpperCase() + s.key.slice(1);
  if (isMac) {
    return `${s.ctrl ? '⌃' : ''}${s.alt ? '⌥' : ''}${s.shift ? '⇧' : ''}${s.mod || s.meta ? '⌘' : ''}${key === 'Enter' ? '↩' : key}`;
  }
  return [s.mod || s.ctrl ? 'Ctrl' : '', s.meta ? 'Meta' : '', s.alt ? 'Alt' : '', s.shift ? 'Shift' : '', key].filter(Boolean).join('+');
}

/** @param {{ platform?: string, userAgent?: string } | undefined} nav */
export function isMacPlatform(nav) {
  const p = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  return /Mac|iPhone|iPad|iPod/.test(p);
}

/**
 * Detects Escape pressed twice within `windowMs` (Panic). Call `press(nowMs)` on each Escape;
 * it returns true on the second press inside the window and then resets.
 * @param {number} [windowMs]
 */
export function createDoublePress(windowMs = PANIC_WINDOW_MS) {
  let last = -Infinity;
  return {
    /** @param {number} nowMs */
    press(nowMs) {
      if (nowMs - last <= windowMs) {
        last = -Infinity;
        return true;
      }
      last = nowMs;
      return false;
    },
    reset() { last = -Infinity; },
  };
}
