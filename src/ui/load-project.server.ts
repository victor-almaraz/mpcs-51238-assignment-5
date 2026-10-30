import 'server-only';
import { auth } from '@clerk/nextjs/server';
import { notFound, redirect } from 'next/navigation';
import { serverClient } from '@/src/lib/supabase-server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProjectRow = { id: string; name: string; source: string; ir: unknown };

/**
 * Loads one project of the signed-in owner. RLS returns no row for another user's project, which
 * becomes a 404 (doc/auth.md: the server checks auth() again; RLS is the boundary).
 */
export async function loadProject(id: string): Promise<{ project: ProjectRow | null; error: string | null }> {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  if (!UUID.test(id)) notFound();
  try {
    const { data, error } = await serverClient().from('projects').select('id,name,source,ir').eq('id', id).is('deleted_at', null).maybeSingle();
    if (error) return { project: null, error: `The project could not be loaded: ${error.message}` };
    if (!data) notFound();
    return { project: { id: String(data.id), name: String(data.name), source: String(data.source ?? ''), ir: data.ir ?? null }, error: null };
  } catch (err) {
    if ((err as { digest?: string })?.digest?.startsWith('NEXT_')) throw err;
    return { project: null, error: `The project could not be loaded: ${(err as Error).message}` };
  }
}
