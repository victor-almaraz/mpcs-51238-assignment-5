'use client';

// Transport and master section (doc/ui.md, Editor; doc/audio/audio-safety.md, Safety UI): Run,
// Stop, Panic / Reset, master volume, meter with 1 s peak hold, Limit badge, the start notice and
// the safety notices with their live regions.

import { useEffect, useRef, useState } from 'react';
import { levelLabel } from '@/src/ui/status.js';
import { PHOTOSENSITIVITY_WARNING, VOLUME_WARNING } from './safety-text';
import type { PieceSession, SessionState } from './hooks';

/** Start notice dismissal lasts for the session (tab) and is never stored. */
let startNoticeDismissed = false;

const btn = 'rounded-sm border border-line px-2 py-0.5 font-mono text-xs hover:bg-panel-2 disabled:opacity-50';

export function useStartNotice(onStart: () => void) {
  const [open, setOpen] = useState(false);
  const request = () => {
    if (startNoticeDismissed) onStart();
    else setOpen(true);
  };
  const dialog = open ? (
    <StartNotice
      onStart={() => { startNoticeDismissed = true; setOpen(false); onStart(); }}
      onCancel={() => setOpen(false)}
    />
  ) : null;
  return { request, dialog };
}

function StartNotice({ onStart, onCancel }: { onStart: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="start-notice-title" aria-describedby="start-notice-text" className="max-w-sm rounded-sm border border-line bg-panel p-4">
        <h2 id="start-notice-title" className="mb-2 font-semibold">Before you start</h2>
        <div id="start-notice-text" className="mb-4 space-y-2 text-sm">
          <p>{VOLUME_WARNING}</p>
          <p>{PHOTOSENSITIVITY_WARNING}</p>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onCancel}>Cancel</button>
          {/* The click on this button is the gesture that starts audio. */}
          <button ref={ref} type="button" className="rounded-sm bg-accent px-3 py-1 font-mono text-xs text-bg" onClick={onStart}>Start sound</button>
        </div>
      </div>
    </div>
  );
}

/** Level meter: peak and RMS from the post-limiter analyser once per animation frame. */
function Meter({ session }: { session: PieceSession | null }) {
  const peak = useRef<HTMLDivElement>(null);
  const rms = useRef<HTMLDivElement>(null);
  const hold = useRef<HTMLDivElement>(null);
  const [limiting, setLimiting] = useState(false);
  const [label, setLabel] = useState(levelLabel(null));
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const pct = (db: number) => `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
    const frame = (t: number) => {
      const m = session?.master;
      if (m) {
        const r = m.meter();
        if (peak.current) peak.current.style.width = pct(r.peakDb);
        if (rms.current) rms.current.style.width = pct(r.rmsDb);
        if (hold.current) hold.current.style.left = pct(r.holdDb);
        if (t - last > 250) { last = t; setLimiting(r.limiting); setLabel(levelLabel(r.holdDb)); }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [session]);
  return (
    <div className="flex items-center gap-1 font-mono text-xs" title="Output level, post-limiter, −60 to 0 dBFS">
      <div className="relative h-2 w-24 border border-line bg-bg" role="meter" aria-label="Output level" aria-valuemin={-60} aria-valuemax={0} aria-valuetext={label}>
        <div ref={rms} className="absolute inset-y-0 left-0 bg-fg-muted" style={{ width: 0 }} />
        <div ref={peak} className="absolute inset-y-0 left-0 bg-fg opacity-40" style={{ width: 0 }} />
        <div ref={hold} className="absolute inset-y-0 w-px bg-fg" style={{ left: 0 }} />
      </div>
      <span className="w-16 tabular-nums">{label}</span>
      {limiting && <span className="border border-line px-1" title="The safety limiter is reducing peaks">Limit</span>}
    </div>
  );
}

export function Transport({ session, state, onRun, canRun, runHint, compact = false, maxDb = 0, startDb = -12 }: {
  session: PieceSession | null; state: SessionState; onRun: () => void; canRun: boolean; runHint?: string | null; compact?: boolean;
  maxDb?: number; startDb?: number;
}) {
  const [db, setDb] = useState(startDb);
  useEffect(() => { setDb(Math.min(startDb, maxDb)); }, [startDb, maxDb]);
  const { request, dialog } = useStartNotice(onRun);
  const playing = state.audio === 'playing' || state.audio === 'starting';
  const muted = state.audio === 'muted';
  return (
    <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Transport">
      <button type="button" className={`${btn} ${playing ? 'border-accent text-accent' : ''}`} onClick={request} disabled={!canRun || !state.ready} title={runHint ?? 'Run (Mod-Enter)'}>
        ▶ Run
      </button>
      <button type="button" className={btn} onClick={() => session?.stop()} disabled={!playing} title="Stop (Mod-.)">■ Stop</button>
      {muted
        ? <button type="button" className={btn} onClick={(e) => session?.reset(e.detail)} title="Single click to end the mute">Reset</button>
        : <button type="button" className={btn} onClick={() => session?.panic()} disabled={!state.ready} title="Panic (Escape twice)">Panic</button>}
      {!compact && (
        <label className="flex items-center gap-1 font-mono text-xs">
          <span>{muted ? 'Muted' : 'Master'}</span>
          <input
            type="range" min={-60} max={maxDb} step={1} value={db}
            aria-label="Master volume" aria-valuetext={`${db} dB`}
            onChange={(e) => { const v = Number(e.target.value); setDb(v); session?.moveVolume(v); }}
          />
          <span className="w-12 tabular-nums">{db} dB</span>
        </label>
      )}
      <Meter session={session} />
      {session?.master?.reduced && <span className="font-mono text-xs text-stale" title="The safety limiter worklet is unavailable; the fallback stage caps the master at −6 dB">Reduced safety mode</span>}
      {dialog}
    </div>
  );
}

export function Notices({ session, state }: { session: PieceSession | null; state: SessionState }) {
  const polite = state.notices.filter((n) => n.live === 'polite');
  const assertive = state.notices.filter((n) => n.live === 'assertive');
  return (
    <>
      <div className="sr-only" aria-live="polite">{polite.map((n) => n.message).join('. ')}</div>
      <div className="sr-only" aria-live="assertive">{assertive.map((n) => n.message).join('. ')}</div>
      {state.notices.length > 0 && (
        <ul className="flex flex-col gap-1 font-mono text-xs">
          {state.notices.map((n) => (
            <li key={n.id} className={`flex items-center gap-2 border px-2 py-1 ${n.kind === 'fault' || n.kind === 'engineFault' ? 'border-down' : 'border-line'}`}>
              <span className="flex-1">{n.message}</span>
              {n.kind === 'duck' && <button type="button" className={btn} onClick={() => session?.restoreLevel()}>Restore Level</button>}
              {n.kind !== 'duck' && n.kind !== 'panic' && <button type="button" className={btn} aria-label="Dismiss" onClick={() => session?.dismiss(n.id)}>×</button>}
            </li>
          ))}
        </ul>
      )}
      {state.error && (
        <p role="alert" className="flex items-center gap-2 font-mono text-xs text-down">
          {state.error} <button type="button" className={btn} onClick={() => session?.clearError()}>Dismiss</button>
        </p>
      )}
    </>
  );
}
