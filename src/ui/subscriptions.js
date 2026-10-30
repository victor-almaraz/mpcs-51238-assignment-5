// Keeps `project_subscriptions` equal to the IR's `groups` (doc/ui.md, Editor;
// doc/database.md, project_subscriptions).

/**
 * @param {readonly string[]} current group keys stored for the project
 * @param {readonly string[]} groups the IR's groups
 * @returns {{ add: string[], remove: string[] }} both sorted
 */
export function diffSubscriptions(current, groups) {
  const have = new Set(current);
  const want = new Set(groups);
  return {
    add: [...want].filter((g) => !have.has(g)).sort(),
    remove: [...have].filter((g) => !want.has(g)).sort(),
  };
}

/**
 * Reads the stored subscriptions of one project and writes the difference. RLS limits every
 * statement to the signed-in owner.
 * @param {any} client Supabase client
 * @param {string} projectId
 * @param {readonly string[]} groups
 * @returns {Promise<{ add: string[], remove: string[] }>}
 */
export async function syncSubscriptions(client, projectId, groups) {
  const { data, error } = await client.from('project_subscriptions').select('group_key').eq('project_id', projectId);
  if (error) throw new Error(`reading subscriptions failed: ${error.message}`);
  const d = diffSubscriptions((data ?? []).map((r) => r.group_key), groups);
  if (d.remove.length) {
    const r = await client.from('project_subscriptions').delete().eq('project_id', projectId).in('group_key', d.remove);
    if (r.error) throw new Error(`removing subscriptions failed: ${r.error.message}`);
  }
  if (d.add.length) {
    const r = await client.from('project_subscriptions').insert(d.add.map((g) => ({ project_id: projectId, group_key: g })));
    if (r.error) throw new Error(`adding subscriptions failed: ${r.error.message}`);
  }
  return d;
}
