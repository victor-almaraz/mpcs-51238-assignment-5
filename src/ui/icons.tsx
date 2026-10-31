// Icons (doc/ui.md, Style): Lucide, 16 px, 2 px stroke. Icons are decorative (aria-hidden); every
// control or state that shows one also has text, so meaning never rests on the icon or its colour.

import {
  CircleCheck, CircleX, Clock, LoaderCircle, Play, Square, TriangleAlert, VolumeX,
  type LucideIcon, type LucideProps,
} from 'lucide-react';

/** Freshness states: a distinct shape for each, besides colour and text. */
export const FRESHNESS_ICON: Record<string, LucideIcon> = { fresh: CircleCheck, stale: Clock, down: CircleX, loading: LoaderCircle };

/** Audio states of the status bar. */
export const AUDIO_ICON: Record<string, LucideIcon> = { playing: Play, stopped: Square, starting: LoaderCircle, muted: VolumeX, fault: TriangleAlert };

/** A decorative icon at text size. */
export function Icon({ as: C, size = 14, className = '', ...rest }: { as: LucideIcon } & LucideProps) {
  return <C aria-hidden="true" focusable="false" size={size} strokeWidth={2} className={`inline-block shrink-0 ${className}`} {...rest} />;
}
