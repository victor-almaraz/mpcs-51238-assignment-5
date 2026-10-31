'use client';

// React hooks over the piece session, the sky store and the trace bus. Browser-only modules are
// imported inside effects, so nothing runs during prerendering.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { records as busRecords, subscribe as busSubscribe } from '@/src/trace/bus.js';
import { isMacPlatform } from '@/src/ui/shortcuts.js';
import { useSettings, useSupabase } from './app-providers';

export type Freshness = { source: string; state: 'loading' | 'fresh' | 'stale' | 'down'; lastRun: string | null; lastSuccess: string | null };
export type TraceRecord = {
  t: string; traceId: string; stage: string; component: string; event: string; level: string;
  data: Record<string, any>; replay?: number; synthetic?: true;
};
export type Problem = { severity: 'error' | 'warning'; code: string; path: string; line: number | null; message: string };
// The session is a plain JS object (src/ui/piece-session.js).
export type PieceSession = any;
export type SessionState = {
  ready: boolean; audio: 'stopped' | 'starting' | 'playing' | 'muted' | 'fault'; mode: 'live' | 'replay' | 'synthetic';
  replay: { speed: number; from: number; to: number; ended: boolean } | null;
  notices: { id: number; kind: string; live: 'polite' | 'assertive'; message: string }[];
  error: string | null; followed: string[]; playingIr: any; visualsAvailable: boolean | null;
};

const INITIAL: SessionState = {
  ready: false, audio: 'stopped', mode: 'live', replay: null, notices: [], error: null, followed: [], playingIr: null, visualsAvailable: null,
};
const noSub = () => () => {};
const initial = () => INITIAL;

/** Creates one piece session for the component's lifetime. */
export function usePieceSession({ kiosk = false }: { kiosk?: boolean } = {}) {
  const { client, ready } = useSupabase();
  const { settings, loaded } = useSettings();
  const [session, setSession] = useState<PieceSession | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // No session (so no Run) before settings load: it would start at the default level (doc/ui.md, Settings schema).
  useEffect(() => {
    if (!ready || !loaded) return;
    let s: PieceSession | null = null;
    let cancelled = false;
    import('@/src/ui/piece-session.js').then(({ createPieceSession }) => {
      if (cancelled) return;
      s = createPieceSession({ client, kiosk, settings: settingsRef.current });
      setSession(s);
    });
    return () => {
      cancelled = true;
      s?.dispose();
      setSession(null);
    };
  }, [client, ready, loaded, kiosk]);

  useEffect(() => { session?.setSettings(settings); }, [session, settings]);

  const state = useSyncExternalStore<SessionState>(
    session ? session.subscribe : noSub,
    session ? session.getState : initial,
    initial,
  );
  return { session, state };
}

/** Freshness of every known source, updated on `freshness` events and every 5 s. */
export function useFreshness(sky: any | null): Freshness[] {
  const [list, setList] = useState<Freshness[]>([]);
  useEffect(() => {
    if (!sky) return;
    const read = () => setList([...sky.sources()]);
    read();
    const off = sky.on('freshness', read);
    const timer = setInterval(read, 5000);
    return () => { off(); clearInterval(timer); };
  }, [sky]);
  return list;
}

/** Buffered trace records, refreshed at most every `throttleMs` while not paused. */
export function useTraceRecords(paused = false, throttleMs = 250): TraceRecord[] {
  const [list, setList] = useState<TraceRecord[]>(() => (typeof window === 'undefined' ? [] : busRecords() as TraceRecord[]));
  useEffect(() => {
    if (paused) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => { timer = null; setList(busRecords() as TraceRecord[]); };
    flush();
    const off = busSubscribe(() => { if (timer === null) timer = setTimeout(flush, throttleMs); });
    return () => { off(); if (timer !== null) clearTimeout(timer); };
  }, [paused, throttleMs]);
  return list;
}

/** Calls `fn` every `ms` while mounted. */
export function useInterval(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function useIsMac() {
  const [mac, setMac] = useState(false);
  useEffect(() => { setMac(isMacPlatform(navigator)); }, []);
  return mac;
}

/** Voices and output level of the session's master, sampled at 4 Hz. */
export function useLevels(session: PieceSession | null) {
  const [v, setV] = useState({ voices: 0, peakDb: -Infinity, limiting: false });
  useInterval(() => {
    const m = session?.master;
    if (!m) return;
    const r = m.meter();
    const next = { voices: m.voices(), peakDb: r.holdDb, limiting: r.limiting };
    setV((p) => (p.voices === next.voices && Math.round(p.peakDb) === Math.round(next.peakDb) && p.limiting === next.limiting ? p : next));
  }, 250);
  return v;
}
