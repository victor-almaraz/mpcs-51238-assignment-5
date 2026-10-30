/**
 * Text summary shown instead of the preview when WebGL2 is unavailable
 * (doc/visuals.md, Renderer).
 */

export const UNAVAILABLE_STATUS = 'Visuals unavailable (WebGL2)';

/**
 * One line per followed group: object count and freshness.
 * @param {string[]} groups
 * @param {{ get(group: string): any[], freshness?(source: string): { state: string } }} sky
 * @returns {string[]}
 */
export function summaryLines(groups, sky) {
  const lines = [];
  for (const g of [...new Set(groups)].sort()) {
    const objects = sky.get(g) ?? [];
    const source = objects[0]?.source ?? g;
    let state = null;
    try { state = sky.freshness?.(source)?.state ?? null; } catch { state = null; }
    const n = objects.length;
    lines.push(`${g}: ${n} ${n === 1 ? 'object' : 'objects'}${state ? `, ${state}` : ''}`);
  }
  return lines.length ? lines : ['This piece follows no groups.'];
}
