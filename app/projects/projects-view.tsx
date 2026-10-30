'use client';

// Projects table (doc/ui.md, Projects): name, groups followed, last edited, last run; Open, Run,
// Duplicate, Delete (soft delete with a 10 s Undo toast); New project from Blank or a starter.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';
import { BLANK_SOURCE, UNDO_MS, createLastRunStore, duplicateName, uniqueName } from '@/src/ui/projects.js';
import { relativeTime } from '@/src/ui/status.js';
import { Attribution } from '@/src/ui/attribution';
import { useSupabase } from '@/src/ui/app-providers';
import { createProject } from '@/src/ui/project-actions';

type Row = { id: string; name: string; updatedAt: string | null; starterSlug: string | null; groups: string[] };
type Template = { slug: string; name: string; source: string; ir: unknown };

const btn = 'rounded-sm border border-line px-2 py-0.5 font-mono text-xs hover:bg-panel-2 disabled:opacity-50';
const primary = 'rounded-sm bg-accent px-3 py-1 font-mono text-xs text-bg disabled:opacity-50';

export function ProjectsView({ rows: initial, error, seedError, templates }: { rows: Row[] | null; error: string | null; seedError: string | null; templates: Template[] }) {
  const router = useRouter();
  const { client } = useSupabase();
  const [rows, setRows] = useState<Row[]>(initial ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(seedError);
  const [toast, setToast] = useState<{ row: Row; index: number } | null>(null);
  const [menu, setMenu] = useState(false);
  const [now, setNow] = useState(() => Date.now());
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
        {busy === 'new' ? 'Creating…' : 'New project'}
      </button>
      {menu && (
        <ul role="menu" className="absolute right-0 z-10 mt-1 w-64 border border-line bg-panel py-1 font-mono text-xs">
          <li role="none"><button role="menuitem" type="button" className="block w-full px-3 py-1 text-left hover:bg-panel-2" onClick={() => newProject(null)}>Blank</button></li>
          {templates.map((t) => (
            <li role="none" key={t.slug}><button role="menuitem" type="button" className="block w-full px-3 py-1 text-left hover:bg-panel-2" onClick={() => newProject(t)}>{t.name}</button></li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-4 border-b border-line px-4 py-2 font-mono text-sm">
        <Link href="/" className="hover:underline">Sphärenmusik</Link>
        <nav aria-label="Site" className="flex flex-1 gap-4">
          <Link href="/learn" className="hover:underline">Guide</Link>
          <Link href="/console" className="hover:underline">Console</Link>
          <Link href="/settings" className="hover:underline">Settings</Link>
        </nav>
        <UserButton />
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <div className="mb-6 flex items-center justify-between gap-4">
          <h1 className="text-xl font-semibold">Projects</h1>
          {!error && templateMenu}
        </div>
        {actionError && <p role="alert" className="mb-4 font-mono text-xs text-down">{actionError} <button type="button" className={btn} onClick={() => setActionError(null)}>Dismiss</button></p>}
        {error ? (
          <div role="alert" className="border border-line p-4 font-mono text-sm">
            <p className="mb-3 text-down">{error}</p>
            <button type="button" className={btn} onClick={() => router.refresh()}>Retry</button>
          </div>
        ) : rows.length === 0 ? (
          <div className="border border-line p-6">
            <p className="mb-4">No projects. Create one from a blank script or start from an example.</p>
            <div className="mb-4 flex flex-wrap gap-2">
              <button type="button" className={btn} onClick={() => newProject(null)} disabled={!client}>New project: Blank</button>
              {templates.map((t) => <button key={t.slug} type="button" className={btn} onClick={() => newProject(t)} disabled={!client}>{t.name}</button>)}
            </div>
            <p className="text-sm">Learning the script? Start with <Link className="underline" href="/learn/first-piece">Your first piece</Link>.</p>
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left font-mono text-xs text-fg-muted">
                <th className="py-1 pr-4 font-normal">Name</th><th className="pr-4 font-normal">Groups followed</th>
                <th className="pr-4 font-normal">Last edited</th><th className="pr-4 font-normal">Last run</th><th className="font-normal"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line align-top">
                  <td className="py-1.5 pr-4"><Link href={`/projects/${r.id}`} className="hover:underline">{r.name}</Link></td>
                  <td className="pr-4 font-mono text-xs">{r.groups.length ? r.groups.join(', ') : <span className="text-fg-muted">none</span>}</td>
                  <td className="pr-4 font-mono text-xs" title={r.updatedAt ?? undefined}>{relativeTime(r.updatedAt, now)}</td>
                  <td className="pr-4 font-mono text-xs">{relativeTime(lastRuns[r.id] ?? null, now)}</td>
                  <td className="whitespace-nowrap py-1">
                    <span className="flex gap-1">
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
        )}
        {!error && rows.length > 0 && (
          <p className="mt-6 text-sm text-fg-muted">Learning the script? Start with <Link className="underline" href="/learn/first-piece">Your first piece</Link>.</p>
        )}
      </main>
      {toast && (
        <div role="status" className="fixed bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 border border-line bg-panel px-4 py-2 font-mono text-sm">
          Project deleted
          <button type="button" className={btn} onClick={undo}>Undo</button>
        </div>
      )}
      <Attribution />
    </div>
  );
}
