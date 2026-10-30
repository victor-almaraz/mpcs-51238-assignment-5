import type { Metadata } from 'next';
import { Suspense } from 'react';
import { loadGuide } from '@/src/learn/guide.js';
import { AppProviders } from '@/src/ui/app-providers';
import { TryView, type Example } from './try-view';

export const metadata: Metadata = { title: 'Try', description: 'Run an example from the guide.' };

/**
 * `/try?src=<slug>/<n>` (doc/guide.md, Try mode). The page is prerendered with every runnable
 * example of the guide; the client picks the one named by `src`.
 */
export default function TryPage() {
  const examples: Record<string, Example> = {};
  for (const page of loadGuide()) {
    page.examples.forEach((ex: { source: string; heading: string }, n: number) => {
      examples[`${page.slug}/${n}`] = { source: ex.source, heading: ex.heading, page: page.title, slug: page.slug };
    });
  }
  return (
    <AppProviders>
      <Suspense fallback={<p className="p-4 font-mono text-xs text-fg-muted">Loading…</p>}>
        <TryView examples={examples} />
      </Suspense>
    </AppProviders>
  );
}
