// The single import point of the engine's definition tables (doc/audio/synthesis-conventions.md,
// doc/audio/effects.md). Nothing else in src/dsl/ imports src/audio/.

export { PARAM_DEFS, TUNING_DEFS } from '../audio/synths/param-defs.js';
export { EFFECTS as EFFECT_REGISTRY } from '../audio/fx/effects/registry.js';
