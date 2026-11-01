// Attribution required by the data sources (doc/sources.md, Attribution).
export const ATTRIBUTION =
  'Orbital data: CelesTrak. Space weather: NOAA SWPC. Close approaches and Scout: NASA/JPL CNEOS. Launches: The Space Devs, Launch Library 2.';

export function Attribution() {
  return <footer className="border-t border-line px-4 py-3 text-xs sm:px-6">{ATTRIBUTION}</footer>;
}
