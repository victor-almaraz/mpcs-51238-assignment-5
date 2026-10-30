'use client';

// Status bar (doc/ui.md, Status bar and States): per-source freshness, audio state, voices,
// output level and save state. Colour is never the only signal: each state has a glyph and text.

import { audioLabel, freshnessItem, levelLabel, saveLabel, voicesLabel, type SaveState } from '@/src/ui/status.js';
import type { Freshness } from './hooks';

const STATE_CLASS: Record<string, string> = {
  loading: 'text-fg-muted', fresh: 'text-accent', stale: 'text-stale', down: 'text-down',
};

type Props = {
  sources: Freshness[];
  timeZone?: string;
  audio?: 'stopped' | 'starting' | 'playing' | 'muted' | 'fault';
  voices?: number;
  levelDb?: number;
  limiting?: boolean;
  save?: SaveState | null;
  saveError?: string | null;
  mode?: string;
  replaySpeed?: number | null;
  note?: string | null;
};

export function StatusBar({ sources, timeZone = 'UTC', audio, voices, levelDb, limiting, save, saveError, mode, replaySpeed, note }: Props) {
  return (
    <footer role="status" aria-label="Status" className="flex min-h-6 flex-wrap items-center gap-x-4 gap-y-0.5 border-t border-line bg-panel px-3 py-0.5 font-mono text-xs">
      <ul aria-label="Source freshness" className="flex flex-wrap gap-x-3">
        {sources.length === 0 && <li className="text-fg-muted" title="No source status received yet">… connecting</li>}
        {sources.map((f) => {
          const it = freshnessItem(f, timeZone);
          return (
            <li key={it.source} title={it.title} className="flex items-baseline gap-1">
              <span aria-hidden="true" className={STATE_CLASS[it.state]}>{it.glyph}</span>
              <span>{it.source}</span>
              <span className="sr-only">{it.title}</span>
              {(it.state === 'stale' || it.state === 'down' || it.state === 'loading') && <span className={STATE_CLASS[it.state]}>{it.label}</span>}
            </li>
          );
        })}
      </ul>
      {mode === 'replay' && <span className="text-stale">REPLAY ×{replaySpeed}</span>}
      {mode === 'synthetic' && <span className="text-stale">SYNTHETIC</span>}
      <span className="flex-1" />
      {note && <span className="text-fg-muted">{note}</span>}
      {audio !== undefined && (
        <span className={audio === 'playing' ? 'text-accent' : audio === 'fault' ? 'text-down' : undefined}>{audioLabel(audio)}</span>
      )}
      {voices !== undefined && <span title="Sounding voices out of 64">{voicesLabel(voices)}</span>}
      {levelDb !== undefined && <span title="Output peak, post-limiter">{levelLabel(levelDb)}{limiting ? ' Limit' : ''}</span>}
      {save && <span title={saveError ?? undefined} className={save === 'offline' || save === 'error' ? 'text-stale' : undefined}>{saveLabel(save)}</span>}
    </footer>
  );
}
