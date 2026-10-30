/*
 * Effect registry: device type → { params, Kernel, label }. Shared by the main
 * thread (UI, compile step) and the worklet (kernel construction).
 */
import { COMPRESSOR_PARAMS, CompressorKernel } from './compressor.js';
import { DELAY_PARAMS, DelayKernel } from './delay.js';
import { DISTORTION_PARAMS, DistortionKernel } from './distortion.js';
import { EQ3_PARAMS, Eq3Kernel } from './eq3.js';
import { FILTER_PARAMS, FilterKernel } from './filter.js';
import { REVERB_PARAMS, ReverbKernel } from './reverb.js';
import { SATURATION_PARAMS, SaturationKernel } from './saturation.js';

export const EFFECTS = Object.freeze({
  eq3: Object.freeze({ params: EQ3_PARAMS, Kernel: Eq3Kernel, label: 'EQ' }),
  filter: Object.freeze({ params: FILTER_PARAMS, Kernel: FilterKernel, label: 'Filter' }),
  compressor: Object.freeze({ params: COMPRESSOR_PARAMS, Kernel: CompressorKernel, label: 'Compressor' }),
  saturation: Object.freeze({ params: SATURATION_PARAMS, Kernel: SaturationKernel, label: 'Saturation' }),
  distortion: Object.freeze({ params: DISTORTION_PARAMS, Kernel: DistortionKernel, label: 'Distortion' }),
  delay: Object.freeze({ params: DELAY_PARAMS, Kernel: DelayKernel, label: 'Delay' }),
  reverb: Object.freeze({ params: REVERB_PARAMS, Kernel: ReverbKernel, label: 'Reverb' }),
});

/** The registry entry for effect `type`, or undefined. */
export function effectFor(type) {
  return Object.hasOwn(EFFECTS, type) ? EFFECTS[type] : undefined;
}
