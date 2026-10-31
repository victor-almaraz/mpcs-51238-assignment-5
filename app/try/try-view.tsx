'use client';

import Link from 'next/link';
import { useAuth } from '@clerk/nextjs';
import { useSearchParams } from 'next/navigation';
import { Workbench } from '@/src/ui/workbench';

export type Example = { source: string; heading: string; page: string; slug: string };

/** Unsaved scratch project from a guide example; follows its IR groups without subscriptions. */
export function TryView({ examples }: { examples: Record<string, Example> }) {
  const src = useSearchParams().get('src') ?? '';
  const { isSignedIn } = useAuth();
  const ex = examples[src];
  if (!ex) {
    return (
      <main className="mx-auto max-w-xl px-4 py-12">
        <h1 className="mb-3 text-xl font-semibold">Example Not Found</h1>
        <p className="mb-4 text-sm">{src ? <>No runnable example is called <code className="font-mono">{src}</code>.</> : 'Open an example with its Try it button in the guide.'}</p>
        <Link className="underline" href="/learn">Learn the Piece Script</Link>
      </main>
    );
  }
  return <Workbench key={src} mode="try" initialSource={ex.source} signedIn={!!isSignedIn} title={ex.heading} />;
}
