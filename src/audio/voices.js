// Voice allocation, caps and stealing (audio-engine-core.md).
// Occupancy is computed from scheduled note-on and note-off times, not ctx.currentTime, so
// allocation behaves the same in offline renders. A voice occupies a slot until `end`
// (Infinity while held), counted regardless of whether it has started yet.

export const MAX_VOICES_PER_WIDGET = 16;
export const MAX_VOICES_GLOBAL = 64;

export class VoicePool {
  constructor(max = MAX_VOICES_GLOBAL) {
    this.max = max;
    this.voices = [];
  }

  prune(t) {
    if (this.voices.some((v) => v.end <= t)) this.voices = this.voices.filter((v) => v.end > t);
  }

  ofOwner(owner) {
    return this.voices.filter((v) => v.owner === owner);
  }

  /** Voices still holding a slot at `t` (stolen voices are fading out and don't count). */
  live(t, owner = null) {
    return this.voices.filter((v) => !v.stolen && v.end > t && (owner === null || v.owner === owner));
  }

  /** Steals until `owner` has room under `cap` and the pool has room under `max`. */
  makeRoom(owner, cap, t) {
    this.prune(t);
    let own = this.live(t, owner);
    while (own.length >= cap) {
      this.steal(pickVictim(own, t), t);
      own = this.live(t, owner);
    }
    let all = this.live(t);
    while (all.length >= this.max) {
      this.steal(pickVictim(all, t), t);
      all = this.live(t);
    }
  }

  add(v) {
    this.voices.push(v);
  }

  steal(v, t) {
    v.stolen = true;
    v.owner.stealVoice(v, t);
  }

  removeOwner(owner) {
    this.voices = this.voices.filter((v) => v.owner !== owner);
  }
}

/** Stealing order: the oldest voice in release, then the oldest held voice. */
function pickVictim(list, t) {
  let rel = null, held = null;
  for (const v of list) {
    if (v.offTime <= t) { if (!rel || v.start < rel.start) rel = v; }
    else if (!held || v.start < held.start) held = v;
  }
  return rel || held;
}
