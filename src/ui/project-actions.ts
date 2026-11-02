// Project writes from the browser through the Clerk-authenticated client; RLS limits each
// statement to the owner (doc/database.md, Grants and RLS).
import { syncSubscriptions } from './subscriptions.js';

export type NewProject = { name: string; source: string; ir: any | null };

/**
 * Inserts a project and its subscriptions; returns the new id. When the subscriptions cannot be
 * written, the new row is deleted again, so a retry reuses the name (doc/ui.md, Projects).
 */
export async function createProject(client: any, p: NewProject): Promise<string> {
  const { data, error } = await client.from('projects')
    .insert({ name: p.name, source: p.source, ir: p.ir, local_only: !!p.ir?.localOnly })
    .select('id').single();
  if (error) throw new Error(`The project could not be created: ${error.message}`);
  const id = String(data.id);
  if (p.ir && Array.isArray(p.ir.groups) && p.ir.groups.length) {
    try {
      await syncSubscriptions(client, id, p.ir.groups);
    } catch (err) {
      await client.from('projects').delete().eq('id', id);
      throw new Error(`The project could not be created: ${(err as Error).message}`);
    }
  }
  return id;
}

/** Names of the user's live projects, newest first. */
export async function listProjects(client: any): Promise<{ id: string; name: string; updatedAt: string }[]> {
  const { data, error } = await client.from('projects').select('id,name,updated_at').is('deleted_at', null).order('updated_at', { ascending: false });
  if (error) throw new Error(`Projects could not be read: ${error.message}`);
  return (data ?? []).map((r: any) => ({ id: String(r.id), name: String(r.name), updatedAt: r.updated_at }));
}
