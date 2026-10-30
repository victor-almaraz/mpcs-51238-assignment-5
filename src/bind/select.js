// Selected set of a voices binding (doc/bindings.md, Sustained voices, step 1).

/**
 * Orders `objects` by `select.by` in `select.order` and keeps the first `select.top`, at most
 * `cap`. Without `select`, keeps the first `cap` objects by id. Objects whose `by` value is
 * not a finite number sort last; ties sort by id.
 * @param {{ id: string, fields: Record<string, unknown> }[]} objects
 * @param {{ top: number, by: string, order?: 'asc' | 'desc' } | null} select
 * @param {number} cap
 * @returns {typeof objects}
 */
export function selectObjects(objects, select, cap) {
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (!select) return [...objects].sort(byId).slice(0, cap);
  const sign = select.order === 'asc' ? 1 : -1;
  const key = (o) => {
    const v = o.fields ? o.fields[select.by] : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const sorted = [...objects].sort((a, b) => {
    const x = key(a), y = key(b);
    if (x === null && y === null) return byId(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    return x === y ? byId(a, b) : sign * (x - y);
  });
  return sorted.slice(0, Math.min(select.top, cap));
}
