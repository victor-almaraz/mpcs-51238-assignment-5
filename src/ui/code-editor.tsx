'use client';

// CodeMirror 6 editor in TypeScript mode (doc/ui.md, Editor completion). Completion, hover and
// type lint come from the type-check worker through @valtown/codemirror-ts; until the worker has
// loaded, the fallback CompletionSource (src/ui/completion.js) completes builder names, options,
// group keys and fields. Type errors are amber (warning), build and validator errors red.
// Everything loads inside an effect, so CodeMirror and the worker never run during prerendering.

import { useEffect, useRef, useState } from 'react';
import type { Problem } from './hooks';

export type EditorApi = { insert: (text: string) => void; focus: () => void; goto: (line: number) => void; getValue: () => string };

type Props = {
  initialValue: string;
  onChange: (value: string) => void;
  buildProblems: Problem[];
  onTypeProblems?: (problems: Problem[]) => void;
  onReady?: (api: EditorApi) => void;
  fontSize?: number;
  theme?: 'dark' | 'light';
  typecheck?: boolean;
  label?: string;
};

export function CodeEditor({ initialValue, onChange, buildProblems, onTypeProblems, onReady, fontSize = 14, theme = 'dark', typecheck = true, label = 'piece.ts' }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<any>(null);
  const problemsRef = useRef<Problem[]>(buildProblems);
  const onChangeRef = useRef(onChange);
  const onTypeRef = useRef(onTypeProblems);
  const forceLint = useRef<(() => void) | null>(null);
  const reconfigure = useRef<((fontSize: number, theme: string) => void) | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [workerState, setWorkerState] = useState<'off' | 'loading' | 'ready' | 'failed'>(typecheck ? 'loading' : 'off');
  onChangeRef.current = onChange;
  onTypeRef.current = onTypeProblems;

  useEffect(() => {
    problemsRef.current = buildProblems;
    forceLint.current?.();
  }, [buildProblems]);

  useEffect(() => { reconfigure.current?.(fontSize, theme); }, [fontSize, theme]);

  useEffect(() => {
    let disposed = false;
    let worker: Worker | null = null;
    (async () => {
      try {
        const [{ EditorView, basicSetup }, { EditorState, Compartment, Prec }, { javascript }, ac, lint, { keymap }, lang, hl, defsMod, completionMod] = await Promise.all([
          import('codemirror'), import('@codemirror/state'), import('@codemirror/lang-javascript'), import('@codemirror/autocomplete'),
          import('@codemirror/lint'), import('@codemirror/view'), import('@codemirror/language'), import('@lezer/highlight'),
          import('@/src/dsl/load-defs.js'), import('@/src/ui/completion.js'),
        ]);
        if (disposed || !host.current) return;
        const { tags: t } = hl;
        const darkHighlight = lang.HighlightStyle.define([
          { tag: [t.keyword, t.modifier, t.operatorKeyword], color: '#c792ea' },
          { tag: [t.string, t.special(t.string)], color: '#c3e88d' },
          { tag: [t.number, t.bool, t.null], color: '#f78c6c' },
          { tag: [t.lineComment, t.blockComment, t.comment], color: '#7f8790', fontStyle: 'italic' },
          { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#82aaff' },
          { tag: [t.propertyName], color: '#d7d9dc' },
          { tag: [t.typeName, t.className], color: '#ffcb6b' },
          { tag: [t.variableName], color: '#d7d9dc' },
        ]);
        const themeComp = new Compartment();
        const themeFor = (size: number, mode: string) => [
          EditorView.theme({
            '&': { height: '100%', fontSize: `${size}px`, backgroundColor: 'var(--panel)', color: 'var(--fg)' },
            '.cm-scroller': { fontFamily: 'var(--font-mono)' },
            '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--fg-muted)', borderRight: '1px solid var(--line)' },
            '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--panel-2)' },
            '.cm-content': { caretColor: 'var(--fg)' },
            '.cm-tooltip': { backgroundColor: 'var(--panel-2)', border: '1px solid var(--line)', color: 'var(--fg)' },
            '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--stale)' },
            '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--down)' },
          }, { dark: mode === 'dark' }),
          lang.syntaxHighlighting(mode === 'dark' ? darkHighlight : lang.defaultHighlightStyle),
        ];

        // Type-check worker (doc/piece-dsl.md, Type checking).
        let tsClient: any = null;
        let tsExt: any[] = [];
        let tsReady = false;
        let tsAutocomplete: any = null;
        if (typecheck) {
          try {
            const [{ connectTypecheck }, cmts] = await Promise.all([import('@/src/dsl/typecheck-client.js'), import('@valtown/codemirror-ts')]);
            worker = new Worker(new URL('../dsl/typecheck-worker.ts', import.meta.url), { type: 'module' });
            tsClient = connectTypecheck(worker as any);
            worker.onerror = () => { if (!disposed) setWorkerState('failed'); };
            tsClient.onProblems((p: Problem[]) => onTypeRef.current?.(p));
            tsAutocomplete = cmts.tsAutocompleteWorker();
            tsExt = [cmts.tsFacetWorker.of({ worker: tsClient, path: '/piece.ts' }), cmts.tsSyncWorker(), cmts.tsHoverWorker()];
            tsClient.initialize().then(() => {
              tsReady = true;
              if (!disposed) setWorkerState('ready');
              const v = viewRef.current;
              if (v) tsClient.updateFile({ path: '/piece.ts', code: v.state.doc.toString() });
              forceLint.current?.();
            }, () => { if (!disposed) setWorkerState('failed'); });
          } catch {
            setWorkerState('failed');
          }
        }

        const fallback = (ctx: any) => {
          const text = ctx.state.sliceDoc(0, ctx.pos);
          const r = completionMod.completeAt(text, defsMod.DEFS, { explicit: ctx.explicit });
          return r ? { from: r.from, options: r.options, validFor: /^[\w$.:-]*$/ } : null;
        };
        const source = async (ctx: any) => {
          if (tsReady && tsAutocomplete) {
            try {
              const r = await tsAutocomplete(ctx);
              if (r && r.options?.length) return r;
            } catch { /* fall back */ }
          }
          return fallback(ctx);
        };

        const toDiagnostics = (view: any, problems: Problem[]) => {
          const doc = view.state.doc;
          return problems.filter((p) => p.line !== null && p.line >= 1 && p.line <= doc.lines).map((p) => {
            const line = doc.line(p.line as number);
            const from = line.from + (line.text.length - line.text.trimStart().length);
            return { from, to: Math.max(from + 1, line.to), severity: p.severity === 'error' ? 'error' : 'warning', message: `${p.message} (${p.code})`, source: 'build' };
          });
        };
        const lintSource = async (view: any) => {
          const out: any[] = toDiagnostics(view, problemsRef.current);
          if (tsReady && tsClient) {
            try {
              const ts = await tsClient.getLints({ path: '/piece.ts', diagnosticCodesToIgnore: [] });
              for (const d of ts ?? []) out.push({ ...d, severity: 'warning', source: 'type_error' });
            } catch { /* worker busy */ }
          }
          return out;
        };

        const state = EditorState.create({
          doc: initialValue,
          extensions: [
            basicSetup,
            javascript({ typescript: true }),
            themeComp.of(themeFor(fontSize, theme)),
            ac.autocompletion({ override: [source], activateOnTyping: true }),
            lint.linter(lintSource, { delay: 400 }),
            lint.lintGutter(),
            ...tsExt,
            Prec.high(keymap.of([{ key: 'Tab', run: ac.acceptCompletion }])),
            EditorView.updateListener.of((u: any) => { if (u.docChanged) onChangeRef.current(u.state.doc.toString()); }),
            EditorView.contentAttributes.of({ 'aria-label': label }),
          ],
        });
        const view = new EditorView({ state, parent: host.current });
        viewRef.current = view;
        forceLint.current = () => lint.forceLinting(view);
        reconfigure.current = (size, mode) => view.dispatch({ effects: themeComp.reconfigure(themeFor(size, mode)) });
        setStatus('ready');
        onReady?.({
          insert: (text) => {
            const { from, to } = view.state.selection.main;
            view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
            view.focus();
          },
          focus: () => view.focus(),
          goto: (n) => {
            const line = view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines)));
            view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
            view.focus();
          },
          getValue: () => view.state.doc.toString(),
        });
      } catch (err) {
        console.error(err);
        if (!disposed) setStatus('error');
      }
    })();
    return () => {
      disposed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
      forceLint.current = null;
      reconfigure.current = null;
      worker?.terminate();
    };
    // The editor is created once; later props flow through refs and compartments.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative h-full min-h-0">
      <div ref={host} className="h-full min-h-0" />
      {status === 'loading' && (
        <div className="absolute inset-0 space-y-2 p-3" aria-label="Loading editor">
          {[60, 40, 75, 30].map((w) => <div key={w} className="h-3 animate-pulse bg-panel-2" style={{ width: `${w}%` }} />)}
        </div>
      )}
      {status === 'error' && <p role="alert" className="p-3 font-mono text-xs text-down">The editor failed to load. Reload the page to retry.</p>}
      {workerState === 'failed' && <p className="absolute bottom-0 right-0 bg-panel px-2 font-mono text-xs text-fg-muted">Type checking unavailable</p>}
    </div>
  );
}
