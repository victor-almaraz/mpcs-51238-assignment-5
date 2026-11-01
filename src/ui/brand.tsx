import Link from 'next/link';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The mark (doc/ui.md, Design system, Brand): a centre, one orbit with one planet, and an outer
 * ring graduated every 10° (36 ticks) from 40 px, every 30° from 24 px, and plain below.
 * Strokes are sized to about one device pixel at every size. Monochrome, in currentColor.
 */
export function Mark({ size = 24, className = '' }: { size?: number; className?: string }) {
  const n = size >= 40 ? 36 : size >= 24 ? 12 : 0;
  const sw = r3(32 / size);
  const ring = 15 - sw / 2;
  const ticks = Array.from({ length: n }, (_, i) => {
    const deg = (i * 360) / n;
    const len = deg % 90 === 0 ? 4 : n === 36 && deg % 30 === 0 ? 2.75 : n === 36 ? 1.5 : 2.5;
    const a = (deg * Math.PI) / 180;
    return { x1: r3(16 + ring * Math.cos(a)), y1: r3(16 + ring * Math.sin(a)), x2: r3(16 + (ring - len) * Math.cos(a)), y2: r3(16 + (ring - len) * Math.sin(a)) };
  });
  const p = (-45 * Math.PI) / 180;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth={sw} aria-hidden="true" className={`shrink-0 ${className}`}>
      <circle cx="16" cy="16" r={ring} />
      {ticks.map((t, i) => <line key={i} {...t} />)}
      <circle cx="16" cy="16" r="8.5" />
      <circle cx="16" cy="16" r="2.75" fill="currentColor" stroke="none" />
      <circle cx={r3(16 + 8.5 * Math.cos(p))} cy={r3(16 + 8.5 * Math.sin(p))} r="2.25" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Mark and wordmark, always together, always linking to `/`. `md` in the site header, `sm` in toolbars. */
export function Brand({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return (
    <Link href="/" className={`flex shrink-0 items-center font-semibold tracking-tight text-fg ${size === 'md' ? 'gap-2 text-[0.9375rem]' : 'gap-1.5 text-xs'}`}>
      <Mark size={size === 'md' ? 24 : 16} />
      Sphärenmusik
    </Link>
  );
}
