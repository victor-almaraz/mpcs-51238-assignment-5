'use client';

import { STATE_LABEL, summarize } from '@/src/landing/live.js';
import { FRESHNESS_ICON, Icon } from '@/src/ui/icons';
import { useSnapshot } from './live-snapshot';

const STATE_CLASS: Record<string, string> = {
  loading: 'text-fg-muted', fresh: 'text-ok', stale: 'text-warn', down: 'text-error',
};

const hhmm = (iso: string | null) => (iso ? iso.slice(11, 16) : '');

export function LiveStrip() {
  const state = useSnapshot();
  if (state.status === 'error') {
    return <p role="status" className="text-xs text-fg-muted">Live data unavailable</p>;
  }
  const items = state.status === 'ready'
    ? summarize(state.snapshot, Date.now())
    : summarize({ objects: [], statuses: [] }, Date.now());
  return (
    <ul aria-label="Live sky data" className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line lg:grid-cols-4">
      {items.map((it) => {
        const st = it.freshness.state;
        const since = st === 'stale' || st === 'down' ? `${STATE_LABEL[st]} since ${hhmm(it.freshness.lastSuccess)} UTC` : STATE_LABEL[st];
        return (
          <li key={it.source} title={`${it.source}: ${since}`} className="flex min-w-0 flex-col gap-1 bg-panel px-4 py-3">
            <span className="flex items-center gap-1.5 text-xs text-fg-muted">
              <Icon as={FRESHNESS_ICON[st]} size={12} className={STATE_CLASS[st]} />{it.label}
            </span>
            <span className="tabular truncate font-mono text-sm">{st === 'loading' ? '…' : it.value}</span>
            <span className="sr-only">({since})</span>
          </li>
        );
      })}
    </ul>
  );
}
