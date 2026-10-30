import { auth } from '@clerk/nextjs/server';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { serverClient } from '@/src/lib/supabase-server';
import { AppProviders } from '@/src/ui/app-providers';
import { needsSeeding, projectRows, seedPayload } from '@/src/ui/projects.js';
import { loadStarters } from '@/src/ui/starters.server';
import { ProjectsView } from './projects-view';

export const metadata: Metadata = { title: 'Projects' };

/**
 * Projects list (doc/ui.md, Projects). Seeds the starter projects through the user's
 * Clerk-authenticated client under RLS when `starters_version` is below the manifest version.
 */
export default async function ProjectsPage() {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  const { version, starters } = await loadStarters();
  let rows: ReturnType<typeof projectRows> | null = null;
  let error: string | null = null;
  let seedError: string | null = null;
  try {
    const sb = serverClient();
    const us = await sb.from('user_settings').select('starters_version').maybeSingle();
    if (us.error) throw new Error(us.error.message);
    if (needsSeeding(us.data?.starters_version, version)) {
      const seeded = await sb.rpc('seed_starters', { p_version: version, p_projects: seedPayload(starters) });
      if (seeded.error) seedError = `The starter projects could not be added: ${seeded.error.message}`;
    }
    const res = await sb.from('projects')
      .select('id,name,updated_at,starter_slug,project_subscriptions(group_key)')
      .is('deleted_at', null)
      .order('updated_at', { ascending: false });
    if (res.error) throw new Error(res.error.message);
    rows = projectRows(res.data ?? []);
  } catch (err) {
    error = `Projects could not be loaded: ${(err as Error).message}`;
  }
  return (
    <AppProviders>
      <ProjectsView rows={rows} error={error} seedError={seedError} templates={starters} />
    </AppProviders>
  );
}
