'use client';

// Replay controls (doc/sky-contract.md, Replay mode; doc/ui.md, Command palette): window and
// speed (1×, 10×, 100×, 1000×) and Go live.

import { useState } from 'react';
import { REPLAY_SPEEDS } from '@/src/sky/replay.js';

export const REPLAY_WINDOWS = [
  { label: 'Last hour', ms: 3600e3 },
  { label: 'Last 6 hours', ms: 6 * 3600e3 },
  { label: 'Last 24 hours', ms: 24 * 3600e3 },
  { label: 'Last 7 days', ms: 7 * 86400e3 - 60e3 },
];

const btn = 'rounded-sm border border-line px-2 py-0.5 hover:bg-panel-2 disabled:opacity-50';

export function ReplayControls({ session, mode, replay, defaultSpeed = 100, disabled = false }: {
  session: any | null; mode: string; replay: { speed: number; from: number; to: number; ended: boolean } | null; defaultSpeed?: number; disabled?: boolean;
}) {
  const [windowMs, setWindowMs] = useState(REPLAY_WINDOWS[0].ms);
  const [speed, setSpeed] = useState<number>(REPLAY_SPEEDS.includes(defaultSpeed) ? defaultSpeed : 100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try { await session.replay({ windowMs, speed }); } catch (err) { setError((err as Error).message); }
    setBusy(false);
  };
  const live = async () => {
    if (!session) return;
    setBusy(true);
    await session.goLive();
    setBusy(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Replay">
      <label>Replay <select className="bg-panel-2" value={windowMs} onChange={(e) => setWindowMs(Number(e.target.value))} disabled={disabled || busy}>
        {REPLAY_WINDOWS.map((w) => <option key={w.ms} value={w.ms}>{w.label}</option>)}
      </select></label>
      <label>at <select className="bg-panel-2" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} disabled={disabled || busy}>
        {REPLAY_SPEEDS.map((s: number) => <option key={s} value={s}>{s}×</option>)}
      </select></label>
      <button type="button" className={btn} onClick={start} disabled={disabled || busy || !session}>Replay</button>
      <button type="button" className={btn} onClick={live} disabled={busy || !session || mode === 'live'}>Go Live</button>
      {mode === 'replay' && replay && (
        <span className="text-warn">Replay ×{replay.speed} from {new Date(replay.from).toISOString().slice(0, 16).replace('T', ' ')} UTC{replay.ended ? ', ended' : ''}</span>
      )}
      {error && <span role="alert" className="text-error">{error}</span>}
    </div>
  );
}
