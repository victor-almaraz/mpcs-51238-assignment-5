'use client';

// Run mode (doc/ui.md, Running) for /projects/[id]/run and /listen: the preview fills the window,
// cursor and chrome start hidden, appear on movement or a key and hide after 3 s idle, overlays toggle with C (console), N (sounding
// voices) and S (status bar), and Escape returns to the editor. `?kiosk=1` is installation mode:
// no cursor, no chrome, one "Begin listening" click starts audio, and the sky store ignores the
// hidden-tab disconnect. Run mode never loads the type-check worker. A piece whose IR has a
// program is built from `source` first, since its handlers live only in the sandbox VM.

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
import { Brand } from './brand';
import { button } from './styles';

export const CHROME_HIDE_MS = 3000;

type Props = { ir: unknown; source?: string | null; name: string; projectId?: string | null; backHref?: string | null; kiosk?: boolean; links?: React.ReactNode };

export function RunView({ ir, source = null, name, projectId = null, backHref = null, kiosk = false, links = null }: Props) {
  const router = useRouter();
  const { settings } = useSettings();
  const { session, state } = usePieceSession({ kiosk });
  const levels = useLevels(session);
  const freshness = useFreshness(session?.sky ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const [chrome, setChrome] = useState(false);
  const [overlay, setOverlay] = useState({ console: false, voices: false, status: !kiosk });
  const [begun, setBegun] = useState(false);
  const records = useTraceRecords(!overlay.console);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The pointer is over the chrome, or focus is inside it: it stays. */
  const holding = useRef({ hover: false, focus: false });

  useEffect(() => {
    if (!session) return;
    const r = loadIr(ir, DEFS);
    const errors = r.problems.filter((p: any) => p.severity === 'error');
    if (!r.ir || errors.length) { setProblem(errors[0]?.message ?? 'The stored piece is invalid'); return; }
    setProblem(null);
    if (!r.ir.program) { session.load(r.ir); return; }
    // Programs run from source: build it so the sandbox VM holds the handlers before the piece
    // can start (doc/ui.md, Running).
    if (typeof source !== 'string') { setProblem('This piece needs its source to run; open it in the editor'); return; }
    let live = true;
    session.sandbox.build(source, DEFS, {}).then((b: any) => {
      if (!live) return;
      const err = b.problems.find((p: any) => p.severity === 'error');
      if (!b.ir || err) { setProblem(err?.message ?? 'The piece did not build'); return; }
      session.load(b.ir);
    });
    return () => { live = false; };
  }, [session, ir, source]);

  const run = useCallback(() => {
    if (!session?.ir) return;
    session.run().catch(() => {});
    if (projectId) createLastRunStore(window.localStorage).set(projectId, Date.now());
  }, [session, projectId]);

  // Cursor and chrome appear on movement, a tap or a key, and hide after CHROME_HIDE_MS idle.
  const reveal = useCallback(() => {
    setChrome(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!holding.current.hover && !holding.current.focus) setChrome(false);
    }, CHROME_HIDE_MS);
  }, []);
  useEffect(() => {
    if (kiosk) return;
    window.addEventListener('pointermove', reveal);
    window.addEventListener('pointerdown', reveal);
    window.addEventListener('keydown', reveal);
    return () => {
      window.removeEventListener('pointermove', reveal);
      window.removeEventListener('pointerdown', reveal);
      window.removeEventListener('keydown', reveal);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [kiosk, reveal]);
  const hold = (key: 'hover' | 'focus', on: boolean) => { holding.current[key] = on; if (!on) reveal(); };

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
    <div data-theme="dark" className={`fixed inset-0 bg-black text-fg ${kiosk || !chrome ? 'cursor-none' : ''}`}>
      <div className="absolute inset-0">
        <Preview session={session} state={state} installation className="h-full w-full"
          prompt={kiosk ? '' : chrome ? 'Press Run to start sound' : 'Move the pointer or press a key to show the controls'} />
      </div>

      {kiosk && !begun && (
        <div className="absolute inset-0 flex items-center justify-center">
          <button
            type="button"
            disabled={!canRun}
            onClick={() => { setBegun(true); run(); }}
            className="cursor-none rounded-sm border border-line bg-black/70 px-6 py-4 text-center text-fg"
          >
            <span className="block text-lg">{canRun ? 'Begin Listening' : 'Loading…'}</span>
            <span className="mt-1 block max-w-md text-xs text-fg-muted">{VOLUME_WARNING}</span>
            <span className="mt-1 block max-w-md text-xs text-fg-muted">{PHOTOSENSITIVITY_WARNING}</span>
          </button>
        </div>
      )}

      {!kiosk && (
        <div
          onPointerEnter={() => hold('hover', true)} onPointerLeave={() => hold('hover', false)}
          onFocus={() => { hold('focus', true); reveal(); }}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hold('focus', false); }}
          className={`absolute inset-x-0 top-0 flex flex-wrap items-center gap-3 bg-black/70 px-3 py-2 transition-opacity ${chrome ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        >
          <Brand size="sm" />
          <span aria-hidden="true" className="text-xs">/</span>
          <h1 className="text-xs font-medium">{name}</h1>
          <Transport session={session} state={state} onRun={run} canRun={canRun} maxDb={settings.audio.maxMasterDb} startDb={settings.audio.masterDb} />
          <span className="flex-1" />
          <span className="text-xs">C console · N voices · S status{backHref ? ' · Esc editor' : ''}</span>
          {backHref && <Link href={backHref} className={button('ghost', 'sm')}>Editor</Link>}
          {links}
        </div>
      )}

      {(problem || state.notices.length > 0 || state.error) && (
        <div className="absolute inset-x-0 top-12 mx-auto w-fit max-w-xl bg-black/80 p-2">
          {problem && <p role="alert" className="text-xs text-error">This piece cannot run: {problem}</p>}
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
