'use client';

// Preview (doc/ui.md, Editor and Running): the renderer mounted into a box. Before the first Run
// the preview shows "Press Run to start sound".

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { PieceSession, SessionState } from './hooks';

export type PreviewHandle = { focus: () => void };

export const Preview = forwardRef<PreviewHandle, { session: PieceSession | null; state: SessionState; installation?: boolean; prompt?: string; className?: string }>(
  function Preview({ session, state, installation = false, prompt = 'Press Run to start sound', className = '' }, ref) {
    const box = useRef<HTMLDivElement>(null);
    const [started, setStarted] = useState(false);
    useImperativeHandle(ref, () => ({ focus: () => box.current?.focus() }), []);
    useEffect(() => {
      if (!session || !box.current) return;
      return session.attachPreview(box.current, { installation });
    }, [session, installation]);
    useEffect(() => { if (state.audio === 'playing') setStarted(true); }, [state.audio]);
    return (
      <div data-theme="dark" className={`relative min-h-0 overflow-hidden bg-black text-fg ${className}`}>
        <div ref={box} tabIndex={-1} className="absolute inset-0 outline-none [&_.visual-summary]:p-3 [&_.visual-summary]:font-mono [&_.visual-summary]:text-xs [&_.visual-summary]:text-fg" aria-label="Preview" />
        {!started && (prompt || !state.ready) && (
          <div className={`pointer-events-none absolute inset-x-0 flex justify-center ${installation ? 'bottom-12' : 'bottom-3'}`}>
            <p className="rounded-sm bg-black/70 px-3 py-1 font-mono text-xs text-fg">{state.ready ? prompt : 'Loading the audio engine…'}</p>
          </div>
        )}
      </div>
    );
  },
);
