// A string divided at 2:1, 3:2 and 4:3 (doc/ui.md, Landing, Spheres).
const RATIOS = [
  { name: 'Octave', ratio: '2:1', part: 1 / 2 },
  { name: 'Fifth', ratio: '3:2', part: 2 / 3 },
  { name: 'Fourth', ratio: '4:3', part: 3 / 4 },
];

export function StringRatios() {
  const W = 360;
  const left = 70;
  const len = 260;
  return (
    <figure className="my-6 max-w-xl">
      <svg viewBox={`0 0 ${W} 130`} role="img" aria-labelledby="ratios-title" className="w-full">
        <title id="ratios-title">
          A string stopped at one half sounds an octave above the open string (2:1), at two thirds a fifth (3:2), and at three quarters a fourth (4:3).
        </title>
        {RATIOS.map((r, i) => {
          const y = 22 + i * 40;
          const stop = left + len * r.part;
          return (
            <g key={r.ratio} fontFamily="ui-monospace, monospace" fontSize="11">
              <text x="0" y={y + 4} fill="var(--fg-muted)">{r.name}</text>
              <line x1={left} y1={y} x2={left + len} y2={y} stroke="var(--line)" strokeWidth="2" />
              <line x1={left} y1={y} x2={stop} y2={y} stroke="var(--accent)" strokeWidth="2" />
              <line x1={stop} y1={y - 7} x2={stop} y2={y + 7} stroke="var(--fg)" strokeWidth="1.5" />
              <text x={stop} y={y + 19} fill="var(--fg)" textAnchor="middle">{r.ratio}</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="text-xs text-fg-muted">Stopping a string at simple fractions of its length gives the consonant intervals.</figcaption>
    </figure>
  );
}
