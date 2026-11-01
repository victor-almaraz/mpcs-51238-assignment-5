'use client';

import Link from 'next/link';
import { useAuth } from '@clerk/nextjs';
import { useSearchParams } from 'next/navigation';
import { SiteHeader } from '@/src/ui/site-header';
import { button, container, heading } from '@/src/ui/styles';
import { Workbench } from '@/src/ui/workbench';

export type Example = { source: string; heading: string; page: string; slug: string };

/** Unsaved scratch project from a guide example; follows its IR groups without subscriptions. */
export function TryView({ examples }: { examples: Record<string, Example> }) {
  const src = useSearchParams().get('src') ?? '';
  const { isSignedIn } = useAuth();
  const ex = examples[src];
  if (!ex) {
    return (
      <div className="flex min-h-screen flex-col">
        <SiteHeader />
        <main className={`${container.page} flex-1`}>
          <h1 className={`${heading.page} mb-4`}>Example Not Found</h1>
          <p className="mb-6 text-sm">{src ? <>No runnable example is called <code className="font-mono">{src}</code>.</> : 'Open an example with its Try It button in the guide.'}</p>
          <Link className={button('secondary')} href="/learn">Learn the Piece Script</Link>
        </main>
      </div>
    );
  }
  return <Workbench key={src} mode="try" parent={{ href: `/learn/${ex.slug}`, label: ex.page }} initialSource={ex.source} signedIn={!!isSignedIn} title={ex.heading} />;
}
