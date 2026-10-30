// Mapping of IR instruments to engine widgets (doc/bindings.md, Audio host, steps 5, 8 and 9).

import { LIMITS } from '../bind/limits.js';
import { canonicalJson } from '../bind/canonical.js';

/**
 * @param {any} ir
 * @param {{ detuneCents?: number, muted?: string[] }} [reactions]
 * @param {Record<string, Record<string, number>>} [followed] inst → current followed param values
 * @returns {any[]} widgets for `engine.sync`
 */
export function irToWidgets(ir, reactions = {}, followed = {}) {
  const muted = new Set(reactions.muted ?? []);
  const detune = reactions.detuneCents ?? 0;
  return ir.instruments.map((i) => ({
    id: i.id, type: i.type, muted: muted.has(i.id), solo: false, armed: false,
    volumeDb: i.volumeDb, part: 'all',
    params: followed[i.id] ? { ...i.params, ...followed[i.id] } : i.params,
    octave: i.octave,
    cents: Math.min(Math.max(i.cents + detune, -LIMITS.maxCents), LIMITS.maxCents),
  }));
}

/**
 * Effect chains of an IR by owner: every instrument id and `master`.
 * @param {any} ir
 * @returns {Map<string, any[]>}
 */
export function chainsOf(ir) {
  const m = new Map();
  for (const i of ir.instruments) m.set(i.id, i.fx ?? []);
  m.set('master', ir.master?.fx ?? []);
  return m;
}

/**
 * Effect slot by id, with its owner.
 * @param {any} ir
 * @returns {Map<string, { slot: any, owner: string }>}
 */
export function slotsOf(ir) {
  const m = new Map();
  for (const [owner, slots] of chainsOf(ir)) for (const slot of slots) m.set(slot.id, { slot, owner });
  return m;
}

/**
 * Ids of entries that were added, removed or changed between two lists, by canonical JSON.
 * @param {any[]} prev @param {any[]} next @param {(x: any) => unknown} [view]
 * @returns {string[]}
 */
export function changedIds(prev, next, view = (x) => x) {
  const a = new Map(prev.map((x) => [x.id, canonicalJson(view(x))]));
  const b = new Map(next.map((x) => [x.id, canonicalJson(view(x))]));
  const out = [];
  for (const [id, v] of b) if (a.get(id) !== v) out.push(id);
  for (const id of a.keys()) if (!b.has(id)) out.push(id);
  return out;
}
