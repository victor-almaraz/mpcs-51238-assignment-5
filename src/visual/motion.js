/**
 * Reduced motion and resolution policy (doc/visuals.md, Visual safety and
 * Renderer; doc/ui.md, Settings schema).
 */

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
/** Reduced motion applies data-driven changes at most this often. */
export const REDUCED_MOTION_STEP_MS = 1000;
export const MIN_PIXEL_RATIO = 0.25;
export const MAX_PIXEL_RATIO = 2;

/**
 * `visual.reducedMotion` is `system` or `on`; any other value is treated as
 * `on`, because the setting can only make the OS preference stricter.
 * @param {unknown} setting
 * @param {boolean} systemPrefersReduced
 */
export function isReducedMotion(setting, systemPrefersReduced) {
  if (setting === 'system') return !!systemPrefersReduced;
  return true;
}

/**
 * Pixel ratio for a renderer: installation mode uses the device ratio up to
 * 2; the editor preview uses `visual.previewScale` (0.25–1).
 * @param {{ installation?: boolean, previewScale?: number, devicePixelRatio?: number }} o
 */
export function pixelRatioFor({ installation = false, previewScale = 0.5, devicePixelRatio = 1 }) {
  const r = installation ? Math.min(devicePixelRatio || 1, MAX_PIXEL_RATIO) : Math.min(1, Math.max(MIN_PIXEL_RATIO, previewScale));
  return clampPixelRatio(r);
}

/** @param {number} r */
export function clampPixelRatio(r) {
  return Number.isFinite(r) ? Math.min(MAX_PIXEL_RATIO, Math.max(MIN_PIXEL_RATIO, r)) : 1;
}

/**
 * Watches the OS preference; returns an unsubscribe function. Without
 * `matchMedia` the preference reads as not reduced.
 * @param {(reduced: boolean) => void} fn
 * @param {{ matchMedia?: (q: string) => any }} [win]
 */
export function watchSystemReducedMotion(fn, win = globalThis) {
  const mq = win.matchMedia?.(REDUCED_MOTION_QUERY);
  if (!mq) { fn(false); return () => {}; }
  const onChange = () => fn(!!mq.matches);
  onChange();
  mq.addEventListener?.('change', onChange);
  return () => mq.removeEventListener?.('change', onChange);
}
