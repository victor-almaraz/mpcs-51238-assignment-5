import { celestrakOmm } from './celestrak.js';
import { jplCad, jplScout } from './jpl.js';
import { ll2Launches } from './ll2.js';
import { swpcKp, swpcRtsw } from './swpc.js';

export { NormalizeError } from './common.js';

/** Normalizer name (registry `normalizer`) → (body, args, ctx) => SkyObject[] */
export const normalizers = { celestrakOmm, swpcKp, swpcRtsw, jplCad, jplScout, ll2Launches };
