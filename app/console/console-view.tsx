'use client';

// Public data console (doc/console.md): Sources, Events and Trace for every group, without
// signing in. Recent events come from `changes` by REST; live events from a sky store that follows
// the ticked groups. No audio, no bindings.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createSky, groupKeys } from '@/src/sky/index.js';
import { changeRowToRecord, mergeEvents } from '@/src/ui/console-filters.js';
import { Attribution } from '@/src/ui/attribution';
import { useSettings, useSupabase } from '@/src/ui/app-providers';
import { ConsoleControls, EventsPanel, SourcesPanel, TracePanel } from '@/src/ui/console-panels';
import { useFreshness, useTraceRecords, type TraceRecord } from '@/src/ui/hooks';
import { StatusBar } from '@/src/ui/status-bar';

const HISTORY_ROWS = 200;
const EXPENSIVE = new Set(['celestrak.cosmos-2251-debris']);
type Tab = 'sources' | 'events' | 'trace';

export function ConsoleView() {
  const { client, ready, error: clientError } = useSupabase();
  const { settings } = useSettings();
  const all = useMemo(() => groupKeys(), []);
  const [groups, setGroups] = useState<string[]>(() => all.filter((g: string) => !EXPENSIVE.has(g)));
  const [sky, setSky] = useState<any | null>(null);
  const [skyError, setSkyError] = useState<string | null>(null);
  const [history, setHistory] = useState<TraceRecord[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [tab, setTab] = useState<Tab>('events');
  const [selected, setSelected] = useState<string | null>(null);
  const records = useTraceRecords(paused);
  const freshness = useFreshness(sky);

  useEffect(() => {
    if (!ready) return;
    if (!client) { setSkyError(clientError ?? 'Live data unavailable'); setHistoryLoading(false); return; }
    let s: any;
    try { s = createSky({ client }); setSky(s); } catch (err) { setSkyError((err as Error).message); }
    return () => { s?.close(); setSky(null); };
  }, [client, ready, clientError]);

  useEffect(() => {
    if (!sky) return;
    sky.follow(groups).catch((err: Error) => setSkyError(err.message));
  }, [sky, groups]);

  const loadHistory = async () => {
    if (!client) return;
    setHistoryLoading(true);
    const { data, error } = await client.from('changes').select('id,trace_id,source,group_key,object_id,kind,diff,at').order('id', { ascending: false }).limit(HISTORY_ROWS);
    setHistoryLoading(false);
    if (error) { setHistoryError(`Recent changes could not be read: ${error.message}`); return; }
    setHistoryError(null);
    setHistory((data ?? []).map(changeRowToRecord).filter((r: TraceRecord | null): r is TraceRecord => r !== null).reverse());
  };
  useEffect(() => { if (client) loadHistory(); }, [client]); // eslint-disable-line react-hooks/exhaustive-deps

  const events = useMemo(() => mergeEvents(history, records), [history, records]);
  const toggle = (g: string) => setGroups((gs) => (gs.includes(g) ? gs.filter((x) => x !== g) : [...gs, g].sort()));
  const tabs: { id: Tab; label: string }[] = [{ id: 'sources', label: 'Sources' }, { id: 'events', label: 'Events' }, { id: 'trace', label: 'Trace' }];
  const btn = 'rounded-sm border border-line px-2 py-0.5 text-xs hover:bg-panel-2';

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-2 text-sm">
        <Link href="/" className="hover:underline">Sphärenmusik</Link>
        <h1 className="text-fg-muted">Console</h1>
        <nav aria-label="Site" className="ml-auto flex gap-4">
          <Link href="/listen" className="hover:underline">Listen</Link>
          <Link href="/learn" className="hover:underline">Guide</Link>
          <Link href="/projects" className="hover:underline">Projects</Link>
        </nav>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside aria-label="Followed groups" className="max-h-48 w-full shrink-0 overflow-y-auto border-b border-line bg-panel p-3 font-mono text-xs md:max-h-none md:w-60 md:border-b-0 md:border-r">
          <div className="mb-2 text-fg-muted">Live Groups</div>
          <ul className="flex flex-col gap-1">
            {all.map((g: string) => (
              <li key={g}>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={groups.includes(g)} onChange={() => toggle(g)} />
                  <span>{g}</span>
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-fg-muted">Debris groups start unticked: each object changes about 12 times a day.</p>
          <p className="mt-3"><Link className="underline" href="/learn/sky-data">Sky data in the guide</Link></p>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-1">
            <div role="tablist" aria-label="Console panels" className="flex gap-1 text-xs">
              {tabs.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                  className={`px-2 py-1 ${tab === t.id ? 'border-b border-accent' : 'text-fg-muted hover:text-fg'}`}>{t.label}</button>
              ))}
            </div>
            <ConsoleControls paused={paused} onPause={setPaused} />
            {historyLoading && <span className="text-xs text-fg-muted">Loading recent changes…</span>}
          </div>
          {(skyError || historyError) && (
            <p role="alert" className="border-b border-line px-3 py-1 text-xs text-down">
              {skyError ?? historyError} {historyError && <button type="button" className={btn} onClick={loadHistory}>Retry</button>}
            </p>
          )}
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {tab === 'sources' && <SourcesPanel client={client} freshness={freshness} timeZone={settings.data.timeZone} />}
            {tab === 'events' && <EventsPanel records={events} followed={groups} groups={all} timeZone={settings.data.timeZone} paused={paused} onSelect={(id) => { setSelected(id); setTab('trace'); }} selected={selected} />}
            {tab === 'trace' && <TracePanel records={records} selected={selected} onSelect={setSelected} timeZone={settings.data.timeZone} />}
          </div>
        </main>
      </div>
      <StatusBar sources={freshness} timeZone={settings.data.timeZone} mode={sky?.mode} />
      <Attribution />
    </div>
  );
}
