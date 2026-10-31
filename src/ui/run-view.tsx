'use client';

// Run mode (doc/ui.md, Running) for /projects/[id]/run and /listen: the preview fills the window,
// chrome hides after 3 s without pointer movement, overlays toggle with C (console), N (sounding
// voices) and S (status bar), and Escape returns to the editor. `?kiosk=1` is installation mode:
// no cursor, no chrome, one "Begin listening" click starts audio, and the sky store ignores the
// hidden-tab disconnect. Run mode never loads the type-check worker.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DEFS } from '@/src/dsl/load-defs.js';
import { loadIr } from '@/src/dsl/migrations.js';
import { sourceOf } from '@/src/sky/groups.js';
import { createLastRunStore } from '@/src/ui/projects.js';
import { statusSources } from '@/src/ui/status.js';
import { useSettings } from './app-providers';
import { EventsPanel, VoicesPanel } from './console-panels';
import { useFreshness, useLevels, usePieceSession, useTraceRecords } from './hooks';
import { Preview } from './preview';
import { PHOTOSENSITIVITY_WARNING, VOLUME_WARNING } from './safety-text';
import { StatusBar } from './status-bar';
import { Notices, Transport } from './transport';

export const CHROME_HIDE_MS = 3000;

type Props = { ir: unknown; name: string; projectId?: string | null; backHref?: string | null; kiosk?: boolean; links?: React.ReactNode };

export function RunView({ ir, name, projectId = null, backHref = null, kiosk = false, links = null }: Props) {
  const router = useRouter();
  const { settings } = useSettings();
  const { session, state } = usePieceSession({ kiosk });
  const levels = useLevels(session);
  const freshness = useFreshness(session?.sky ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const [chrome, setChrome] = useState(true);
  const [overlay, setOverlay] = useState({ console: false, voices: false, status: !kiosk });
  const [begun, setBegun] = useState(false);
  const records = useTraceRecords(!overlay.console);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!session) return;
    const r = loadIr(ir, DEFS);
    const errors = r.problems.filter((p: any) => p.severity === 'error');
    if (!r.ir || errors.length) { setProblem(errors[0]?.message ?? 'The stored piece is invalid'); return; }
    setProblem(null);
    session.load(r.ir);
  }, [session, ir]);

  const run = useCallback(() => {
    if (!session?.ir) return;
    session.run().catch(() => {});
    if (projectId) createLastRunStore(window.localStorage).set(projectId, Date.now());
  }, [session, projectId]);

  // While the piece plays, chrome hides after 3 s without pointer movement; while stopped it stays.
  const sounding = state.audio !== 'stopped';
  useEffect(() => {
    if (kiosk) { setChrome(false); return; }
    const show = () => {
      setChrome(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (sounding) hideTimer.current = setTimeout(() => setChrome(false), CHROME_HIDE_MS);
    };
    show();
    window.addEventListener('pointermove', show);
    window.addEventListener('pointerdown', show);
    return () => {
      window.removeEventListener('pointermove', show);
      window.removeEventListener('pointerdown', show);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [kiosk, sounding]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
      const k = e.key.toLowerCase();
      if (k === 'c') setOverlay((o) => ({ ...o, console: !o.console }));
      else if (k === 'n') setOverlay((o) => ({ ...o, voices: !o.voices }));
      else if (k === 's') setOverlay((o) => ({ ...o, status: !o.status }));
      else if (e.key === 'Escape' && backHref && !kiosk) router.push(backHref);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [backHref, kiosk, router]);

  const followedSources = state.followed.map((g) => sourceOf(g) ?? g);
  const canRun = !!session?.ir && state.ready && !problem;

  return (
    <div data-theme="dark" className={`fixed inset-0 bg-black text-fg ${kiosk ? 'cursor-none' : ''}`}>
      <div className="absolute inset-0">
        <Preview session={session} state={state} installation className="h-full w-full" prompt={kiosk ? '' : 'Press Run to start sound'} />
      </div>

      {kiosk && !begun && (
        <div className="absolute inset-0 flex items-center justify-center">
          <button
            type="button"
            disabled={!canRun}
            onClick={() => { setBegun(true); run(); }}
            className="cursor-none rounded-sm border border-line bg-black/70 px-6 py-4 text-center font-mono text-fg"
          >
            <span className="block text-lg">{canRun ? 'Begin listening' : 'Loading…'}</span>
            <span className="mt-1 block max-w-md text-xs text-fg-muted">{VOLUME_WARNING}</span>
            <span className="mt-1 block max-w-md text-xs text-fg-muted">{PHOTOSENSITIVITY_WARNING}</span>
          </button>
        </div>
      )}

      {!kiosk && (
        <div className={`absolute inset-x-0 top-0 flex flex-wrap items-center gap-3 bg-black/70 px-3 py-2 transition-opacity ${chrome ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
          <h1 className="font-mono text-sm">{name}</h1>
          <Transport session={session} state={state} onRun={run} canRun={canRun} maxDb={settings.audio.maxMasterDb} startDb={settings.audio.masterDb} />
          <span className="flex-1" />
          <span className="font-mono text-xs text-fg-muted">C console · N voices · S status{backHref ? ' · Esc editor' : ''}</span>
          {backHref && <Link href={backHref} className="font-mono text-xs underline">Editor</Link>}
          {links}
        </div>
      )}

      {(problem || state.notices.length > 0 || state.error) && (
        <div className="absolute inset-x-0 top-12 mx-auto w-fit max-w-xl bg-black/80 p-2">
          {problem && <p role="alert" className="font-mono text-xs text-down">This piece cannot run: {problem}</p>}
          <Notices session={session} state={state} />
        </div>
      )}

      {overlay.console && (
        <div className="absolute bottom-8 left-2 h-1/3 w-[min(48rem,90vw)] overflow-hidden border border-line bg-black/80 p-2" aria-label="Console overlay">
          <EventsPanel records={records} followed={state.followed} groups={state.followed} timeZone={settings.data.timeZone} paused={false} />
        </div>
      )}
      {overlay.voices && (
        <div className="absolute bottom-8 right-2 max-h-1/2 w-[min(32rem,90vw)] overflow-auto border border-line bg-black/80 p-2" aria-label="Sounding voices overlay">
          <VoicesPanel session={session} />
        </div>
      )}
      {overlay.status && (
        <div className="absolute inset-x-0 bottom-0">
          <StatusBar sources={statusSources(freshness, followedSources)} timeZone={settings.data.timeZone} audio={state.audio} voices={levels.voices} levelDb={levels.peakDb} limiting={levels.limiting} mode={state.mode} replaySpeed={state.replay?.speed ?? null}
            note={state.visualsAvailable === false ? 'Visuals unavailable (WebGL2)' : null} />
        </div>
      )}
    </div>
  );
}
