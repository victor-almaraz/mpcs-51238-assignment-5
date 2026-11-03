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
 * Pixel ratio for a renderer: run and installation mode use the device ratio
 * up to 2; the editor preview uses that ratio times `visual.previewScale`
 * (0.25–1), a fraction of the display's resolution.
 * @param {{ installation?: boolean, previewScale?: number, devicePixelRatio?: number }} o
 */
export function pixelRatioFor({ installation = false, previewScale = 1, devicePixelRatio = 1 }) {
  const device = Math.min(Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1, MAX_PIXEL_RATIO);
  const scale = Number.isFinite(previewScale) ? Math.min(1, Math.max(0.25, previewScale)) : 1;
  return clampPixelRatio(installation ? device : device * scale);
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
