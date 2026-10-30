import type { Metadata } from 'next';
import { AppProviders } from '@/src/ui/app-providers';
import { ConsoleView } from './console-view';

export const metadata: Metadata = { title: 'Console', description: 'Sources, runs and events of every group.' };

/** Public data console (doc/console.md, Access). */
export default function ConsolePage() {
  return (
    <AppProviders>
      <ConsoleView />
    </AppProviders>
  );
}
