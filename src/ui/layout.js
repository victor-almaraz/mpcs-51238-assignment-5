// Editor layout (doc/ui.md, Editor, Layout): which of the side panel, preview and bottom panel show.

export const LAYOUT_KEY = 'sphaerenmusik.layout';
export const DEFAULT_LAYOUT = Object.freeze({ side: true, preview: true, panel: true });

/**
 * Reads the stored layout. Missing, unreadable or malformed entries give the default, field by field.
 * @param {Pick<Storage, 'getItem'> | null} storage
 * @returns {{ side: boolean, preview: boolean, panel: boolean }}
 */
export function loadLayout(storage) {
  let raw = null;
  try { raw = JSON.parse(storage?.getItem(LAYOUT_KEY) ?? 'null'); } catch { raw = null; }
  const out = { ...DEFAULT_LAYOUT };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULT_LAYOUT)) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  }
  return out;
}

/**
 * Stores the layout. Storage errors (quota, private mode) are ignored: the layout is a convenience.
 * @param {Pick<Storage, 'setItem'> | null} storage
 * @param {{ side: boolean, preview: boolean, panel: boolean }} layout
 */
export function saveLayout(storage, layout) {
  try { storage?.setItem(LAYOUT_KEY, JSON.stringify({ side: !!layout.side, preview: !!layout.preview, panel: !!layout.panel })); } catch { /* ignored */ }
}
