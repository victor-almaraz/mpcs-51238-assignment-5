// How engine unit labels read in the guide and in editor hover text: spelled out,
// or empty for dimensionless values. content/learn/reference.md follows this table.

/** @type {Readonly<Record<string, string>>} */
export const UNIT_LABELS = Object.freeze({
  oct: 'octaves', 'per-s': 'grains/s', fraction: '', ratio: '', offset: '', index: '',
});

/** Display label for an engine unit. @param {string | undefined} unit */
export function unitLabel(unit) {
  if (!unit) return '';
  return Object.hasOwn(UNIT_LABELS, unit) ? UNIT_LABELS[unit] : unit;
}
