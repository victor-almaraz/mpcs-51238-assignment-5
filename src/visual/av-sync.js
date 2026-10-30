/**
 * Audio-visual synchronization (doc/visuals.md): the context time the
 * listener hears now.
 */

/**
 * @param {{ currentTime: number, outputLatency?: number, baseLatency?: number,
 *   getOutputTimestamp?: () => { contextTime?: number, performanceTime?: number } }} ctx
 * @param {() => number} [perfNow]
 * @returns {number} seconds in the context's time base
 */
export function audioNow(ctx, perfNow = () => performance.now()) {
  const ts = ctx.getOutputTimestamp?.();
  if (ts && Number.isFinite(ts.contextTime) && Number.isFinite(ts.performanceTime) && /** @type {number} */ (ts.contextTime) <= ctx.currentTime) {
    return /** @type {number} */ (ts.contextTime) + (perfNow() - /** @type {number} */ (ts.performanceTime)) / 1000;
  }
  return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
}
