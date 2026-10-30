// The normalized definition tables of the running app: the user's engine tables, the layer tables
// and the group lists. The page posts DEFS to the sandbox and passes it to the validator.

import { normalizeDefs } from './defs.js';
import { EFFECT_REGISTRY, PARAM_DEFS, TUNING_DEFS } from './engine-defs.js';
import { LAYER_DEFS } from './layer-schema.js';
import { GROUPS } from './sky-schema.js';

export const DEFS = normalizeDefs({
  paramDefs: PARAM_DEFS,
  tuningDefs: TUNING_DEFS,
  effectRegistry: EFFECT_REGISTRY,
  layerDefs: LAYER_DEFS,
  groups: GROUPS,
});
