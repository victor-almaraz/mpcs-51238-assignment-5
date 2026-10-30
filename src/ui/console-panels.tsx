'use client';

// Console panels (doc/console.md, Panels): Sources, Events, Trace, Sounding voices, Modulation
// and Effects, with pause, resume, follow-live and clear. The console reads the trace bus and the
// sky store; it adds no Realtime subscription and does not affect playback.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { chain as busChain, clear as busClear, toJsonl } from '@/src/trace/bus.js';
import {
  clockTime, createAnnouncer, diffSummary, fieldDiff, filterEvents, formatValue, midiHz, noteName, recordBadge, sourceRows, ANNOUNCE_MS,
} from '@/src/ui/console-filters.js';
import { formatHHMM, freshnessItem, relativeTime } from '@/src/ui/status.js';
import { useInterval, type Freshness, type PieceSession, type TraceRecord } from './hooks';

const STATE_CLASS: Record<string, string> = { loading: 'text-fg-muted', fresh: 'text-accent', stale: 'text-stale', down: 'text-down' };
const LEVEL_CLASS: Record<string, string> = { info: '', warn: 'text-stale', error: 'text-down' };
const btn = 'rounded-sm border border-line px-2 py-0.5 hover:bg-panel-2 disabled:opacity-50';

export function downloadTrace() {
  const blob = new Blob([toJsonl()], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sphaerenmusik-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Pause, resume, clear and download. Follow live is a toggle on each scrolling list. */
export function ConsoleControls({ paused, onPause }: { paused: boolean; onPause: (p: boolean) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
      <button type="button" className={btn} onClick={() => onPause(!paused)} aria-pressed={paused}>{paused ? 'Resume' : 'Pause'}</button>
      <button type="button" className={btn} onClick={() => busClear()}>Clear</button>
      <button type="button" className={btn} onClick={downloadTrace}>Download trace</button>
    </div>
  );
}

/** Keeps a scroll container at the bottom while `follow` is on; scrolling up turns it off. */
function useFollow(dep: unknown, follow: boolean, setFollow: (f: boolean) => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [dep, follow]);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    if (!atBottom && follow) setFollow(false);
  };
  return { ref, onScroll };
}

// ---- Sources ----

type RunRow = { source_id: string; started_at: string; finished_at: string; ok: boolean; rows_changed: number; http_status: number | null; error: string | null };

export function SourcesPanel({ client, freshness, timeZone = 'UTC' }: { client: any | null; freshness: Freshness[]; timeZone?: string }) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [sample, setSample] = useState<{ source: string; text: string } | null>(null);

  const load = async () => {
    if (!client) { setLoading(false); setError('The database is unavailable'); return; }
    const { data, error: e } = await client.from('runs')
      .select('source_id,started_at,finished_at,ok,rows_changed,http_status,error')
      .order('started_at', { ascending: false }).limit(300);
    setLoading(false);
    if (e) { setError(`Runs could not be read: ${e.message}`); return; }
    setError(null);
    setRuns(Array.isArray(data) ? data : []);
  };
  useEffect(() => { load(); }, [client]); // eslint-disable-line react-hooks/exhaustive-deps
  useInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);

  const rows = useMemo(() => sourceRows(freshness, runs), [freshness, runs]);

  const expand = async (source: string) => {
    if (open === source) { setOpen(null); return; }
    setOpen(source);
    setSample({ source, text: 'Loading…' });
    if (!client) return;
    const { data, error: e } = await client.from('source_samples').select('fetched_at,http_status,body').eq('source_id', source).maybeSingle();
    if (e) setSample({ source, text: `The sample could not be read: ${e.message}` });
    else if (!data) setSample({ source, text: 'No sample stored for this source.' });
    else {
      let body = String(data.body);
      try { body = JSON.stringify(JSON.parse(body), null, 2); } catch { /* not JSON */ }
      setSample({ source, text: `HTTP ${data.http_status}, fetched ${data.fetched_at}\n\n${body.slice(0, 20000)}` });
    }
  };

  return (
    <div className="font-mono text-xs">
      {error && (
        <p role="alert" className="mb-2 text-down">{error} <button type="button" className={btn} onClick={() => { setLoading(true); load(); }}>Retry</button></p>
      )}
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-fg-muted">
            <th className="py-0.5 pr-3 font-normal">Source</th><th className="pr-3 font-normal">State</th><th className="pr-3 font-normal">Last run</th>
            <th className="pr-3 font-normal">Rows changed</th><th className="pr-3 font-normal">Duration</th><th className="font-normal">Last error</th>
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 && [0, 1, 2].map((i) => (
            <tr key={i}><td colSpan={6} className="py-1"><div className="h-3 w-2/3 animate-pulse bg-panel-2" /></td></tr>
          ))}
          {!loading && rows.length === 0 && <tr><td colSpan={6} className="py-1 text-fg-muted">No sources have reported yet.</td></tr>}
          {rows.map((r) => {
            const it = freshnessItem({ source: r.source, state: r.state as Freshness['state'], lastRun: r.lastRun, lastSuccess: r.lastSuccess }, timeZone);
            return [
              <tr key={r.source} className="border-t border-line align-top">
                <td className="py-0.5 pr-3">
                  <button type="button" className="hover:underline" aria-expanded={open === r.source} onClick={() => expand(r.source)}>
                    {open === r.source ? '▾' : '▸'} {r.source}
                  </button>
                </td>
                <td className="pr-3" title={it.title}><span aria-hidden="true" className={STATE_CLASS[it.state]}>{it.glyph}</span> {it.label}</td>
                <td className="pr-3">{r.lastRun ? `${formatHHMM(r.lastRun, timeZone)} (${relativeTime(r.lastRun, Date.now())})` : '—'}</td>
                <td className="pr-3">{r.rowsChanged ?? '—'}</td>
                <td className="pr-3">{r.ms === null ? '—' : `${r.ms} ms`}</td>
                <td className={r.lastError ? 'text-down' : 'text-fg-muted'}>{r.lastError ? `${r.lastError}${r.lastErrorAt ? ` (${formatHHMM(r.lastErrorAt, timeZone)})` : ''}` : '—'}</td>
              </tr>,
              open === r.source && (
                <tr key={`${r.source}-sample`}>
                  <td colSpan={6}>
                    <pre className="max-h-64 overflow-auto border border-line bg-bg p-2">{sample?.source === r.source ? sample.text : ''}</pre>
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- Events ----

export function EventsPanel({ records, followed, groups, timeZone = 'UTC', paused, onSelect, selected }: {
  records: TraceRecord[]; followed: string[]; groups: string[]; timeZone?: string; paused: boolean;
  onSelect?: (traceId: string) => void; selected?: string | null;
}) {
  const [source, setSource] = useState('');
  const [group, setGroup] = useState('');
  const [followedOnly, setFollowedOnly] = useState(false);
  const [firedOnly, setFiredOnly] = useState(false);
  const [follow, setFollow] = useState(true);
  const [announce, setAnnounce] = useState('');
  const announcer = useRef(createAnnouncer());
  const lastCount = useRef(0);

  const events = useMemo(() => filterEvents(records, { source: source || undefined, group: group || undefined, followedOnly, followed, firedOnly }), [records, source, group, followedOnly, followed, firedOnly]);
  const shown = events.slice(-500);
  const sources = useMemo(() => [...new Set(records.filter((r) => r.stage === 'CHANGE').map((r) => String(r.data?.source ?? '')))].filter(Boolean).sort(), [records]);
  const { ref, onScroll } = useFollow(shown.length, follow, setFollow);

  useEffect(() => {
    const n = events.length;
    if (n > lastCount.current) announcer.current.add(n - lastCount.current);
    lastCount.current = n;
  }, [events.length]);
  useEffect(() => { announcer.current.pause(paused); }, [paused]);
  useInterval(() => { const m = announcer.current.flush(); if (m) setAnnounce(m); }, ANNOUNCE_MS);

  return (
    <div className="flex h-full min-h-0 flex-col gap-1 font-mono text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <label>Source <select className="bg-panel-2" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">all</option>{sources.map((s) => <option key={s}>{s}</option>)}
        </select></label>
        <label>Group <select className="bg-panel-2" value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">all</option>{groups.map((g) => <option key={g}>{g}</option>)}
        </select></label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={followedOnly} onChange={(e) => setFollowedOnly(e.target.checked)} /> Followed groups only</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={firedOnly} onChange={(e) => setFiredOnly(e.target.checked)} /> Fired bindings only</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow live</label>
        <span className="text-fg-muted">{events.length} events{paused ? ' (paused)' : ''}</span>
      </div>
      <div className="sr-only" aria-live="polite">{announce}</div>
      <div ref={ref} onScroll={onScroll} role="log" aria-label="Events" className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 && <p className="text-fg-muted">No events yet. Events appear when a followed group changes.</p>}
        {shown.map((r, i) => {
          const badge = recordBadge(r);
          const d = r.data ?? {};
          return (
            <button
              type="button"
              key={`${r.traceId}-${d.objectId}-${i}`}
              onClick={() => onSelect?.(r.traceId)}
              className={`block w-full truncate text-left hover:bg-panel-2 ${selected === r.traceId ? 'bg-panel-2' : ''}`}
              title={fieldDiff(d.diff).map((x) => `${x.field}: ${formatValue(x.before)} → ${formatValue(x.after)}`).join('\n')}
            >
              <span className="text-fg-muted">{clockTime(r.t, timeZone)}</span>{' '}
              <span>CHANGE</span> <span>{d.objectId}</span> <span className="text-accent">{d.kind}</span>
              {d.initial ? <span className="text-fg-muted"> initial</span> : null}
              {d.history ? <span className="text-fg-muted"> history</span> : null}
              {badge && <span className="text-stale"> {badge}</span>}{' '}
              <span className="text-fg-muted">{diffSummary(d.diff)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- Trace ----

export function TracePanel({ records, selected, onSelect, timeZone = 'UTC' }: { records: TraceRecord[]; selected: string | null; onSelect: (id: string) => void; timeZone?: string }) {
  const [follow, setFollow] = useState(true);
  const recent = records.slice(-400);
  const { ref, onScroll } = useFollow(recent.length, follow, setFollow);
  const chainRecords = useMemo(() => (selected ? (busChain(selected) as TraceRecord[]) : []), [selected, records]); // eslint-disable-line react-hooks/exhaustive-deps
  const line = (r: TraceRecord, i: number, sel: boolean) => (
    <button
      type="button"
      key={`${r.traceId}-${i}`}
      onClick={() => onSelect(r.traceId)}
      className={`block w-full truncate text-left hover:bg-panel-2 ${sel ? 'bg-panel-2' : ''} ${LEVEL_CLASS[r.level] ?? ''}`}
    >
      <span className="text-fg-muted">{clockTime(r.t, timeZone)}</span> {r.stage.padEnd(8)} {r.component} {r.event}
      {recordBadge(r) && <span className="text-stale"> {recordBadge(r)}</span>}{' '}
      <span className="text-fg-muted">{JSON.stringify(r.data).slice(0, 160)}</span>
    </button>
  );
  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-2 font-mono text-xs md:grid-cols-2">
      <div className="flex min-h-0 flex-col">
        <div className="text-fg-muted">Recent records <label className="ml-2"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow live</label></div>
        <div ref={ref} onScroll={onScroll} role="log" aria-label="Trace records" className="min-h-0 flex-1 overflow-y-auto">
          {recent.length === 0 && <p className="text-fg-muted">No trace records yet.</p>}
          {recent.map((r, i) => line(r, i, r.traceId === selected))}
        </div>
      </div>
      <div className="flex min-h-0 flex-col">
        <div className="text-fg-muted">{selected ? `Chain ${selected}` : 'Select a record to see its causal chain'}</div>
        <ol aria-label="Causal chain" className="min-h-0 flex-1 overflow-y-auto">
          {chainRecords.map((r, i) => (
            <li key={i} className={`border-b border-line py-0.5 ${LEVEL_CLASS[r.level] ?? ''}`}>
              <div>{r.stage} · {r.component} · {r.event} <span className="text-fg-muted">{clockTime(r.t, timeZone)}</span>{recordBadge(r) && <span className="text-stale"> {recordBadge(r)}</span>}</div>
              <pre className="whitespace-pre-wrap text-fg-muted">{JSON.stringify(r.data, null, 1)}</pre>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// ---- Sounding voices ----

export function VoicesPanel({ session }: { session: PieceSession | null }) {
  const [voices, setVoices] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  useInterval(() => {
    const rt = session?.host?.runtime;
    setVoices(rt ? rt.voices() : []);
  }, 500);
  const ir = session?.ir;
  const instName = (id: string) => {
    const i = ir?.instruments?.find((x: any) => x.id === id);
    return i ? `${i.type} ${id}` : id;
  };
  const boundFields = (bindingId: string) => {
    const b = ir?.bindings?.find((x: any) => x.id === bindingId);
    const out = new Set<string>();
    const walk = (n: any) => {
      if (!n || typeof n !== 'object') return;
      if (n.op === 'field' && typeof n.args?.[0] === 'string') out.add(n.args[0]);
      for (const a of n.args ?? []) walk(a);
    };
    if (b) for (const k of ['pitch', 'velocity', 'pan']) walk(b[k]);
    if (b?.voiceMods) for (const v of Object.values(b.voiceMods)) walk(v);
    return [...out];
  };
  const select = (id: string) => {
    const next = selected === id ? null : id;
    setSelected(next);
    session?.highlight(next);
  };
  if (!session?.host?.runtime) return <p className="font-mono text-xs text-fg-muted">No voices. Press Run to start the piece.</p>;
  return (
    <table className="w-full font-mono text-xs">
      <thead><tr className="text-left text-fg-muted"><th className="font-normal">Instrument</th><th className="font-normal">Object</th><th className="font-normal">Bound fields</th><th className="font-normal">Pitch</th></tr></thead>
      <tbody>
        {voices.length === 0 && <tr><td colSpan={4} className="text-fg-muted">No sounding voices.</td></tr>}
        {voices.map((v) => (
          <tr key={v.source} className={`cursor-pointer border-t border-line hover:bg-panel-2 ${selected === v.objectId ? 'bg-panel-2' : ''}`} onClick={() => select(v.objectId)} aria-selected={selected === v.objectId}>
            <td>{instName(v.inst)}</td>
            <td>{String(v.fields?.name ?? v.objectId)}</td>
            <td>{boundFields(v.binding).map((f) => `${f}=${formatValue(v.fields?.[f])}`).join(' ') || '—'}</td>
            <td>{noteName(v.pitch)} {midiHz(v.pitch).toFixed(1)} Hz</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---- Modulation ----

export function ModulationPanel({ session }: { session: PieceSession | null }) {
  const [tick, setTick] = useState(0);
  useInterval(() => setTick((t) => t + 1), 100);
  const ir = session?.ir;
  const engine = session?.host?.engine;
  const rt = session?.host?.runtime;
  const sources = useMemo(() => (rt ? rt.dataSources() : []), [rt, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ir) return <p className="font-mono text-xs text-fg-muted">No piece loaded.</p>;
  const mods: any[] = ir.mods ?? [];
  if (!mods.length && !(ir.lfos ?? []).length) return <p className="font-mono text-xs text-fg-muted">This piece has no modulation. Add <code>.mod(...)</code> to a parameter.</p>;
  const base = (target: string) => {
    const [owner, param] = target.split('.');
    const inst = ir.instruments.find((i: any) => i.id === owner);
    if (inst) return inst.params?.[param];
    for (const i of [...ir.instruments, { fx: ir.master?.fx ?? [] }]) {
      const s = (i.fx ?? []).find((x: any) => x.id === owner);
      if (s) return s.params?.[param];
    }
    return undefined;
  };
  const targets = [...new Set(mods.map((m) => m.target))];
  const lfo = (id: string) => (ir.lfos ?? []).find((l: any) => l.id === id);
  return (
    <div className="font-mono text-xs">
      <ul>
        {targets.map((target) => {
          const modulated = typeof engine?.modulatedValue === 'function' ? engine.modulatedValue(target) : null;
          return (
            <li key={target} className="border-b border-line py-0.5">
              {target} {formatValue(base(target))} → {modulated === null || modulated === undefined ? '—' : formatValue(modulated)}
              {mods.filter((m) => m.target === target).map((m, i) => {
                const src = typeof m.source === 'string' ? m.source : m.source?.lfo ?? 'expr';
                const l = typeof src === 'string' ? lfo(src) : null;
                return <span key={i} className="text-fg-muted"> ← {l ? `${l.id} ${l.shape ?? ''} ${typeof l.rate === 'number' ? `${l.rate} Hz` : ''}` : src} ({m.depth})</span>;
              })}
            </li>
          );
        })}
      </ul>
      {sources.length > 0 && (
        <table className="mt-2 w-full">
          <thead><tr className="text-left text-fg-muted"><th className="font-normal">Data source</th><th className="font-normal">Class</th><th className="font-normal">Raw</th><th className="font-normal">Posted</th></tr></thead>
          <tbody>
            {sources.map((s: any) => (
              <tr key={s.id} className="border-t border-line">
                <td>{s.id}</td>
                <td>{s.class}{s.timeScale > 1 ? ` time-scaled ×${s.timeScale}` : ''}</td>
                <td>{formatValue(s.raw)}</td>
                <td>{formatValue(s.posted)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---- Effects ----

export function EffectsPanel({ session, records }: { session: PieceSession | null; records: TraceRecord[] }) {
  const ir = session?.ir;
  if (!ir) return <p className="font-mono text-xs text-fg-muted">No piece loaded.</p>;
  const faulted = new Set(records.filter((r) => r.stage === 'SAFETY' && r.event === 'fxFault').map((r) => r.data?.slot));
  const chains: [string, any[]][] = [
    ...ir.instruments.map((i: any) => [`${i.type} ${i.id}`, i.fx ?? []] as [string, any[]]),
    ['master', ir.master?.fx ?? []],
  ];
  const any = chains.some(([, slots]) => slots.length > 0);
  if (!any) return <p className="font-mono text-xs text-fg-muted">This piece has no effects. Add one with <code>inst.fx(reverb(...))</code>.</p>;
  return (
    <ul className="font-mono text-xs">
      {chains.filter(([, s]) => s.length).map(([owner, slots]) => (
        <li key={owner} className="border-b border-line py-0.5">
          {owner}: {slots.map((s, i) => (
            <span key={s.id}>{i > 0 ? ' → ' : ''}{s.id} {s.type}{s.bypass ? ' (bypassed)' : ''}{faulted.has(s.id) ? <span className="text-down"> fault, reset and bypassed</span> : ''}</span>
          ))}
        </li>
      ))}
    </ul>
  );
}

/** Problems panel (doc/guide.md, Links from the app): each problem links to the troubleshooting page. */
export function ProblemsPanel({ problems, onGoto }: { problems: { severity: string; code: string; path: string; line: number | null; message: string }[]; onGoto?: (line: number) => void }) {
  if (!problems.length) return <p className="font-mono text-xs text-fg-muted">No problems.</p>;
  return (
    <ul className="font-mono text-xs" aria-label="Problems">
      {problems.map((p, i) => (
        <li key={i} className="flex gap-2 border-b border-line py-0.5">
          <span className={p.severity === 'error' ? 'text-down' : 'text-stale'}>{p.severity === 'error' ? '✖ error' : '▲ warning'}</span>
          {p.line !== null && onGoto
            ? <button type="button" className="hover:underline" onClick={() => onGoto(p.line as number)}>piece.ts:{p.line}</button>
            : <span className="text-fg-muted">{p.path || 'piece'}</span>}
          <span className="flex-1">{p.message}</span>
          <Link className="text-fg-muted underline" href={`/learn/troubleshooting#${p.code}`} target="_blank">{p.code}</Link>
        </li>
      ))}
    </ul>
  );
}
