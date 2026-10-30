import { auth } from '@clerk/nextjs/server';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AppProviders } from '@/src/ui/app-providers';
import { SettingsView } from './settings-view';

export const metadata: Metadata = { title: 'Settings' };

/** User settings (doc/ui.md, Settings and Settings schema). */
export default async function SettingsPage() {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  return (
    <AppProviders>
      <SettingsView />
    </AppProviders>
  );
}
