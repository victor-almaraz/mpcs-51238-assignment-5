'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { browserClient } from '@/src/lib/supabase-browser';
import { fetchSnapshot, POLL_MS } from '@/src/landing/live.js';

type Snapshot = Awaited<ReturnType<typeof fetchSnapshot>>;
type State = { status: 'loading' } | { status: 'ready'; snapshot: Snapshot; at: number } | { status: 'error'; message: string };

const Ctx = createContext<State>({ status: 'loading' });
export const useSnapshot = () => useContext(Ctx);

/** Reads the landing snapshot by REST on load and every 60 s while the tab is visible. */
export function LiveSnapshot({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let client: ReturnType<typeof browserClient>;
    try {
      client = browserClient(async () => null);
    } catch (err) {
      setState({ status: 'error', message: (err as Error).message });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const load = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const snapshot = await fetchSnapshot(client);
        if (!stopped) setState({ status: 'ready', snapshot, at: Date.now() });
      } catch (err) {
        if (!stopped) setState((s) => (s.status === 'ready' ? s : { status: 'error', message: (err as Error).message }));
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => { await load(); if (!stopped) schedule(); }, POLL_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') { load(); schedule(); } else clearTimeout(timer);
    };
    load();
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}
