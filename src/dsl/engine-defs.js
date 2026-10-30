// The single import point of the user's engine definition tables (doc/audio/synthesis-conventions.md,
// doc/audio/effects.md). Nothing else in src/dsl/ imports src/audio/.
//
// ASSUMPTION: PARAM_DEFS and TUNING_DEFS are exported by src/audio/param-defs.js. The docs name the
// tables but not their module; confirm the path with the user.
// The effect registry module is src/audio/fx/effects/registry.js (doc/audio/effects.md, Components).
// Its export name is not documented; EFFECT_REGISTRY is taken from the first of EFFECT_REGISTRY,
// REGISTRY, EFFECTS or the default export. Each entry is a ParamDef list or `{ params: ParamDef[] }`.

import * as registry from '../audio/fx/effects/registry.js';

export { PARAM_DEFS, TUNING_DEFS } from '../audio/param-defs.js';

const reg = /** @type {any} */ (registry);
export const EFFECT_REGISTRY = reg.EFFECT_REGISTRY ?? reg.REGISTRY ?? reg.EFFECTS ?? reg.default;
