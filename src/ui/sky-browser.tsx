'use client';

// Sky browser (doc/ui.md, Editor): groups by source, followed groups marked, live sample values of
// each field. Clicking a field inserts `field('<name>')`; group headers link to /learn/sky-data.

import { useEffect, useMemo, useState } from 'react';
import { GROUPS } from '@/src/sky/groups.js';
import { formatValue } from '@/src/ui/console-filters.js';
import { CircleCheck } from 'lucide-react';
import { Icon } from './icons';
import { SourceGlyph } from './glyphs';

const PROVIDERS = ['celestrak', 'swpc', 'jpl', 'll2'];

export function SkyBrowser({ sky, followed, onInsert }: { sky: any | null; followed: string[]; onInsert?: (text: string) => void }) {
  const [, setTick] = useState(0);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!sky) return;
    let pending = false;
    const bump = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; setTick((t) => t + 1); }, 1000);
    };
    const offs = ['enter', 'update', 'exit'].map((t) => sky.on(t, bump));
    return () => offs.forEach((o: () => void) => o());
  }, [sky]);

  const byProvider = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const g of Object.keys(GROUPS)) {
      const p = g.split('.')[0];
      if (!out.has(p)) out.set(p, []);
      out.get(p)?.push(g);
    }
    return [...out.entries()].sort((a, b) => {
      const ia = PROVIDERS.indexOf(a[0]);
      const ib = PROVIDERS.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a[0].localeCompare(b[0]);
    });
  }, []);
  const followedSet = new Set(followed);

  return (
    <div className="font-mono text-xs">
      {byProvider.map(([provider, groups]) => (
        <details key={provider} open={open[provider] ?? groups.some((g) => followedSet.has(g))} onToggle={(e) => { const o = (e.target as HTMLDetailsElement).open; setOpen((s) => ({ ...s, [provider]: o })); }}>
          <summary className="cursor-pointer py-0.5"><span className="inline-flex items-center gap-1.5 align-middle"><SourceGlyph id={`${provider}.x`} size={12} />{provider}</span></summary>
          <ul className="pl-3">
            {groups.map((g) => {
              const def = GROUPS[g];
              const sample = sky ? sky.get(g)[0] ?? null : null;
              const count = sky ? sky.get(g).length : 0;
              const isFollowed = followedSet.has(g);
              return (
                <li key={g} className="py-0.5">
                  <details>
                    <summary className="cursor-pointer">
                      <a href="/learn/sky-data" target="_blank" rel="noreferrer" className="hover:underline" title="Sky data in the guide" onClick={(e) => e.stopPropagation()}>{g}</a>
                      {isFollowed ? <span className="ml-1 inline-flex items-center gap-0.5 align-middle text-ok" title="Followed by this piece"><Icon as={CircleCheck} size={12} />followed</span> : null}
                      <span className="text-fg-muted"> {isFollowed ? `${count} obj` : ''}</span>
                    </summary>
                    <ul className="pl-3">
                      {Object.entries(def.fields).map(([name, f]) => (
                        <li key={name}>
                          <button
                            type="button"
                            disabled={!onInsert}
                            onClick={() => onInsert?.(`field('${name}')`)}
                            title={`Insert field('${name}')`}
                            className="flex w-full gap-2 text-left hover:bg-fg hover:text-bg"
                          >
                            <span>{name}</span>
                            <span className="text-fg-muted">{f.unit}</span>
                            <span className="ml-auto truncate text-fg-muted">{sample ? formatValue(sample.fields[name]) : ''}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              );
            })}
          </ul>
        </details>
      ))}
      {!sky && <p className="text-fg-muted">Connecting…</p>}
    </div>
  );
}
