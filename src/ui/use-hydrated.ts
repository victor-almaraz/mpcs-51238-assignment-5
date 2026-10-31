'use client';

import { useSyncExternalStore } from 'react';

const noSub = () => () => {};

/**
 * False during prerendering and hydration, true afterwards. Values that differ between the
 * server and the browser (window.location, the Supabase client) wait for it, so hydration matches.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(noSub, () => true, () => false);
}
