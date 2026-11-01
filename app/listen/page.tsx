import type { Metadata } from 'next';
import Link from 'next/link';
import stationChord from '@/content/starters/station-chord.ir.json';
import manifest from '@/content/starters/manifest.json';
import { AppProviders } from '@/src/ui/app-providers';
import { RunView } from '@/src/ui/run-view';
import { button } from '@/src/ui/styles';

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
          <nav aria-label="Site" className="flex gap-1">
            <Link className={button('ghost', 'sm')} href="/learn/first-piece">How It Works</Link>
            <Link className={button('ghost', 'sm')} href="/console">Console</Link>
            <Link className={button('ghost', 'sm')} href="/projects">Compose</Link>
          </nav>
        )}
      />
    </AppProviders>
  );
}
