import type { Metadata } from 'next';
import Link from 'next/link';
import stationChord from '@/content/starters/station-chord.ir.json';
import manifest from '@/content/starters/manifest.json';
import { AppProviders } from '@/src/ui/app-providers';
import { RunView } from '@/src/ui/run-view';

export const metadata: Metadata = { title: 'Listen', description: 'The station-chord piece, live, without an account.' };

const NAME = manifest.starters.find((s) => s.slug === 'station-chord')?.name ?? 'Station chord';

/** The station-chord starter in run mode, public (doc/ui.md, Routes). Runs only its stored IR. */
export default function ListenPage() {
  return (
    <AppProviders>
      <RunView
        ir={stationChord}
        name={NAME}
        links={(
          <nav aria-label="Site" className="flex gap-3 font-mono text-xs">
            <Link className="underline" href="/learn/first-piece">How it works</Link>
            <Link className="underline" href="/console">Console</Link>
            <Link className="underline" href="/projects">Compose</Link>
          </nav>
        )}
      />
    </AppProviders>
  );
}
