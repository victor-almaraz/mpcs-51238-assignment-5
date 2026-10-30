'use client';

// Per-tab Supabase client (doc/auth.md, Clients) and user settings (doc/ui.md, Settings schema).
// The client is created once in the browser with the Clerk session token; signed-out visitors
// pass a function returning null. Settings come from `user_settings` when signed in, otherwise
// the defaults.

import { useAuth } from '@clerk/nextjs';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { browserClient } from '@/src/lib/supabase-browser';
import { DEFAULT_SETTINGS, validateSettings } from '@/src/lib/settings.js';

export type Settings = typeof DEFAULT_SETTINGS;
export type SettingsWarning = { path: string; message: string };

type SupabaseState = { client: SupabaseClient | null; error: string | null; ready: boolean };
type SettingsState = {
  settings: Settings;
  warnings: SettingsWarning[];
  loaded: boolean;
  error: string | null;
  save: (next: unknown) => Promise<{ warnings: SettingsWarning[] }>;
  signedIn: boolean;
};

const SupabaseCtx = createContext<SupabaseState>({ client: null, error: null, ready: false });
const SettingsCtx = createContext<SettingsState>({
  settings: DEFAULT_SETTINGS, warnings: [], loaded: false, error: null, signedIn: false,
  save: async () => ({ warnings: [] }),
});

export const useSupabase = () => useContext(SupabaseCtx);
export const useSettings = () => useContext(SettingsCtx);

function SupabaseProvider({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn } = useAuth();
  const tokenRef = useRef(getToken);
  const signedInRef = useRef(isSignedIn);
  useEffect(() => { tokenRef.current = getToken; signedInRef.current = isSignedIn; }, [getToken, isSignedIn]);
  const [state, setState] = useState<SupabaseState>({ client: null, error: null, ready: false });

  useEffect(() => {
    try {
      const client = browserClient(async () => (signedInRef.current ? (await tokenRef.current()) ?? null : null));
      setState({ client, error: null, ready: true });
    } catch (err) {
      setState({ client: null, error: `Live data unavailable: ${(err as Error).message}`, ready: true });
    }
  }, []);

  return <SupabaseCtx.Provider value={state}>{children}</SupabaseCtx.Provider>;
}

function SettingsProvider({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  const { client } = useSupabase();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [warnings, setWarnings] = useState<SettingsWarning[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn || !client) { setLoaded(true); return; }
    let stopped = false;
    client.from('user_settings').select('settings').maybeSingle().then(({ data, error: e }) => {
      if (stopped) return;
      if (e) { setError(`Settings could not be loaded: ${e.message}`); setLoaded(true); return; }
      const v = validateSettings(data?.settings ?? {});
      setSettings(v.settings as Settings);
      setWarnings(v.warnings);
      setLoaded(true);
    }, (err: Error) => { if (!stopped) { setError(`Settings could not be loaded: ${err.message}`); setLoaded(true); } });
    return () => { stopped = true; };
  }, [isLoaded, isSignedIn, client]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.editor.theme;
  }, [settings.editor.theme]);

  const save = useCallback(async (next: unknown) => {
    const v = validateSettings(next);
    setSettings(v.settings as Settings);
    setWarnings(v.warnings);
    if (!isSignedIn || !client) return { warnings: v.warnings };
    const { error: e } = await client.from('user_settings')
      .upsert({ settings: v.settings, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (e) throw new Error(e.message);
    setError(null);
    return { warnings: v.warnings };
  }, [isSignedIn, client]);

  const value = useMemo(() => ({ settings, warnings, loaded, error, save, signedIn: !!isSignedIn }), [settings, warnings, loaded, error, save, isSignedIn]);
  return <SettingsCtx.Provider value={value}>{children}</SettingsCtx.Provider>;
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <SupabaseProvider>
      <SettingsProvider>{children}</SettingsProvider>
    </SupabaseProvider>
  );
}
