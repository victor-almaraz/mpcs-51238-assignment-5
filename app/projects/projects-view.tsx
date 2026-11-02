'use client';

// Projects table (doc/ui.md, Projects): name, groups followed, last edited, last run; Open, Run,
// Duplicate, Delete (soft delete with a 10 s Undo toast); New project from Blank or a starter.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BLANK_SOURCE, UNDO_MS, createLastRunStore, duplicateName, uniqueName } from '@/src/ui/projects.js';
import { relativeTime } from '@/src/ui/status.js';
import { Attribution } from '@/src/ui/attribution';
import { useSupabase } from '@/src/ui/app-providers';
import { createProject } from '@/src/ui/project-actions';
import { button, container, heading, table, textLink } from '@/src/ui/styles';
import { SiteHeader } from '@/src/ui/site-header';
import type { Template } from '@/src/ui/workbench';

type Row = { id: string; name: string; updatedAt: string | null; starterSlug: string | null; groups: string[] };

const btn = button('secondary', 'sm');
const primary = button('primary');

export function ProjectsView({ rows: initial, error, seedError, templates }: { rows: Row[] | null; error: string | null; seedError: string | null; templates: Template[] }) {
  const router = useRouter();
  const { client } = useSupabase();
  const [rows, setRows] = useState<Row[]>(initial ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(seedError);
  const [toast, setToast] = useState<{ row: Row; index: number } | null>(null);
  const [menu, setMenu] = useState(false);
  // Read after mount, so the server render and the first client render agree.
  const [now, setNow] = useState<number | null>(null);
  const [lastRuns, setLastRuns] = useState<Record<string, number | null>>({});
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setRows(initial ?? []); }, [initial]);
  useEffect(() => {
    const store = createLastRunStore(window.localStorage);
    setLastRuns(Object.fromEntries(rows.map((r) => [r.id, store.get(r.id)])));
    setNow(Date.now());
  }, [rows]);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const names = useMemo(() => rows.map((r) => r.name), [rows]);

  const newProject = async (t: Template | null) => {
    if (!client) return;
    setBusy('new');
    setMenu(false);
    try {
      const id = await createProject(client, { name: uniqueName(t ? t.name : 'Untitled', names), source: t ? t.source : BLANK_SOURCE, ir: t ? t.ir : null });
      router.push(`/projects/${id}`);
    } catch (err) {
      setActionError((err as Error).message);
      setBusy(null);
    }
  };

  const duplicate = async (row: Row) => {
    if (!client) return;
    setBusy(row.id);
    try {
      const { data, error: e } = await client.from('projects').select('source,ir').eq('id', row.id).single();
      if (e) throw new Error(e.message);
      const name = duplicateName(row.name, names);
      const id = await createProject(client, { name, source: data.source, ir: data.ir });
      setRows((rs) => [{ id, name, updatedAt: new Date().toISOString(), starterSlug: null, groups: row.groups }, ...rs]);
    } catch (err) {
      setActionError(`Duplicate failed: ${(err as Error).message}`);
    }
    setBusy(null);
  };

  const remove = async (row: Row) => {
    if (!client) return;
    const index = rows.findIndex((r) => r.id === row.id);
    setRows((rs) => rs.filter((r) => r.id !== row.id));
    const { error: e } = await client.from('projects').update({ deleted_at: new Date().toISOString() }).eq('id', row.id);
    if (e) {
      setRows((rs) => { const next = [...rs]; next.splice(index, 0, row); return next; });
      setActionError(`Delete failed: ${e.message}`);
      return;
    }
    setToast({ row, index });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), UNDO_MS);
  };

  const undo = async () => {
    if (!client || !toast) return;
    const { row, index } = toast;
    setToast(null);
    const { error: e } = await client.from('projects').update({ deleted_at: null }).eq('id', row.id);
    if (e) { setActionError(`Undo failed: ${e.message}`); return; }
    setRows((rs) => { const next = [...rs]; next.splice(Math.min(index, next.length), 0, row); return next; });
  };

  const templateMenu = (
    <div className="relative">
      <button type="button" className={primary} onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-haspopup="menu" disabled={busy === 'new' || !client}>
        {busy === 'new' ? 'Creating…' : 'New Project'}
      </button>
      {menu && (
        <ul role="menu" className="absolute right-0 z-10 mt-1 w-64 rounded-md border border-line bg-bg py-1 text-sm">
          <li role="none"><button role="menuitem" type="button" className="block w-full px-3 py-1.5 text-left hover:bg-fg hover:text-bg" onClick={() => newProject(null)}>Blank</button></li>
          {templates.map((t) => (
            <li role="none" key={t.slug}><button role="menuitem" type="button" className="block w-full px-3 py-1.5 text-left hover:bg-fg hover:text-bg" onClick={() => newProject(t)}>{t.name}</button></li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className={`${container.page} flex-1`}>
        <div className="mb-6 flex items-center justify-between gap-4">
          <h1 className={heading.page}>Projects</h1>
          {!error && templateMenu}
        </div>
        {actionError && <p role="alert" className="mb-4 text-xs text-error">{actionError} <button type="button" className={btn} onClick={() => setActionError(null)}>Dismiss</button></p>}
        {error ? (
          <div role="alert" className="border border-line p-4 text-sm">
            <p className="mb-3 text-error">{error}</p>
            <button type="button" className={btn} onClick={() => router.refresh()}>Retry</button>
          </div>
        ) : rows.length === 0 ? (
          <div className="border border-line p-6">
            <p className="mb-4">No projects. Create one from a blank script or start from an example.</p>
            <div className="mb-4 flex flex-wrap gap-2">
              <button type="button" className={btn} onClick={() => newProject(null)} disabled={!client}>New Project: Blank</button>
              {templates.map((t) => <button key={t.slug} type="button" className={btn} onClick={() => newProject(t)} disabled={!client}>{t.name}</button>)}
            </div>
            <p className="text-sm">Learning the script? Start with <Link className={textLink} href="/learn/first-piece">Your first piece</Link>.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className={table.table}>
              <thead>
                <tr className={table.head}>
                  <th className={table.th}>Name</th><th className={table.th}>Groups Followed</th>
                  <th className={table.th}>Last Edited</th><th className={table.th}>Last Run</th><th className={table.th}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={table.row}>
                    <td className={table.td}><Link href={`/projects/${r.id}`} className="font-medium hover:underline">{r.name}</Link></td>
                    <td className={`${table.td} font-mono text-xs`}>{r.groups.length ? r.groups.join(', ') : 'none'}</td>
                    <td className={`${table.td} whitespace-nowrap`} title={r.updatedAt ?? undefined}>{now === null ? '' : relativeTime(r.updatedAt, now)}</td>
                    <td className={`${table.td} whitespace-nowrap`}>{now === null ? '' : relativeTime(lastRuns[r.id] ?? null, now)}</td>
                    <td className={table.td}>
                      <span className="flex justify-end gap-1.5">
                        <Link className={btn} href={`/projects/${r.id}`}>Open</Link>
                        <Link className={btn} href={`/projects/${r.id}/run`}>Run</Link>
                        <button type="button" className={btn} onClick={() => duplicate(r)} disabled={busy === r.id}>Duplicate</button>
                        <button type="button" className={btn} onClick={() => remove(r)} aria-label={`Delete ${r.name}`}>Delete</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!error && rows.length > 0 && (
          <p className="mt-6 text-sm text-fg-muted">Learning the script? Start with <Link className={textLink} href="/learn/first-piece">Your first piece</Link>.</p>
        )}
      </main>
      {toast && (
        <div role="status" className="fixed bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 border border-line bg-panel px-4 py-2 text-sm">
          Project deleted
          <button type="button" className={btn} onClick={undo}>Undo</button>
        </div>
      )}
      <Attribution />
    </div>
  );
}
