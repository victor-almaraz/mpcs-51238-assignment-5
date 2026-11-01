/** One astronomical symbol per data family (doc/ui.md, Design system, Glyphs). */
type Family = 'orbits' | 'weather' | 'approaches' | 'launches';

const PREFIX: Record<string, Family> = { celestrak: 'orbits', swpc: 'weather', jpl: 'approaches', ll2: 'launches' };

/** Family of a source or group id such as `celestrak.stations`, or null. */
function familyOf(id: string): Family | null {
  return PREFIX[id.split('.')[0]] ?? null;
}

const SHAPES: Record<Family, React.ReactNode> = {
  // ⊕ Earth
  orbits: <><circle cx="8" cy="8" r="5.75" /><path d="M8 2.25v11.5M2.25 8h11.5" /></>,
  // ☉ Sun
  weather: <><circle cx="8" cy="8" r="5.75" /><circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" /></>,
  // ☄ Comet
  approaches: <><circle cx="11.25" cy="4.75" r="2.5" fill="currentColor" stroke="none" /><path d="M9.5 6.5 2.5 13.5M10.75 7.75 6.5 12M8.25 5.25 4 9.5" /></>,
  // ☊ Ascending node
  launches: <><path d="M4.5 11.25V8a3.5 3.5 0 0 1 7 0v3.25" /><circle cx="4.5" cy="12.75" r="1.5" /><circle cx="11.5" cy="12.75" r="1.5" /></>,
};

export function Glyph({ family, size = 16, className = '' }: { family: Family; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" className={`shrink-0 ${className}`}>
      {SHAPES[family]}
    </svg>
  );
}

/** The glyph for a source or group id, or nothing for an unknown prefix. */
export function SourceGlyph({ id, size = 16, className = '' }: { id: string; size?: number; className?: string }) {
  const f = familyOf(id);
  return f ? <Glyph family={f} size={size} className={className} /> : null;
}
