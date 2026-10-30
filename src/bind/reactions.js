// Freshness reactions (doc/bindings.md, Freshness reactions).

/**
 * @typedef {{ on: 'stale' | 'down', source: string, actions: { detuneCents?: number, mute?: string[],
 *   only?: string[], desaturate?: number } }} Reaction
 * @typedef {{ detuneCents: number, muted: string[], desaturate: number, active: number[] }} ReactionState
 */

/**
 * Combined effect of the active reactions. A reaction is active while any source it matches is
 * in its state. `'*'` matches `pieceSources`; a group key matches its source. `detuneCents` and
 * `desaturate` take the largest value; mutes take the union.
 * @param {Reaction[]} reactions
 * @param {Map<string, string>} states        source → FreshState
 * @param {string[]} instrumentIds
 * @param {string[]} pieceSources             sources of the piece's groups
 * @param {(group: string) => string} [groupSource]
 * @returns {ReactionState}
 */
export function computeReactionState(reactions, states, instrumentIds, pieceSources, groupSource = (g) => g) {
  /** @type {number | null} */
  let detuneCents = null;
  let desaturate = 0;
  const muted = new Set();
  const active = [];
  reactions.forEach((r, i) => {
    const sources = r.source === '*' ? pieceSources : [groupSource(r.source)];
    if (!sources.some((s) => states.get(s) === r.on)) return;
    active.push(i);
    const a = r.actions ?? {};
    if (typeof a.detuneCents === 'number' && Number.isFinite(a.detuneCents)) detuneCents = detuneCents === null ? a.detuneCents : Math.max(detuneCents, a.detuneCents);
    if (typeof a.desaturate === 'number' && Number.isFinite(a.desaturate)) desaturate = Math.max(desaturate, Math.min(Math.max(a.desaturate, 0), 1));
    for (const id of a.mute ?? []) muted.add(id);
    if (Array.isArray(a.only)) for (const id of instrumentIds) if (!a.only.includes(id)) muted.add(id);
  });
  return { detuneCents: detuneCents ?? 0, muted: instrumentIds.filter((id) => muted.has(id)), desaturate, active };
}
