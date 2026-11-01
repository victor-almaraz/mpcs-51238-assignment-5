'use client';

// The editor screen (doc/ui.md, Editor), used by /projects/[id] and /try (doc/guide.md, Try mode).
// Saving rebuilds the IR in the sandbox, validates it and hot-reloads the running piece; a failed
// build focuses Problems and leaves the running piece unchanged. Only Run starts audio.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { DEFS } from '@/src/dsl/load-defs.js';
import { loadIr } from '@/src/dsl/migrations.js';
import { sourceOf } from '@/src/sky/groups.js';
import { createAutosave } from '@/src/ui/autosave.js';
import { validateIr } from '@/src/dsl/validate.js';
import { acceptBuild, blocking } from '@/src/ui/ir-helpers.js';
import { COMMANDS, availableCommands } from '@/src/ui/palette.js';
import { BLANK_SOURCE, createLastRunStore, nameError, uniqueName } from '@/src/ui/projects.js';
import { DEFAULT_LAYOUT, loadLayout, saveLayout } from '@/src/ui/layout.js';
import { SHORTCUTS, createDoublePress, formatShortcut, shortcutFor } from '@/src/ui/shortcuts.js';
import { statusSources, type SaveState } from '@/src/ui/status.js';
import { syncSubscriptions } from '@/src/ui/subscriptions.js';
import { REPLAY_WINDOWS } from './replay-controls';
import { useSettings, useSupabase } from './app-providers';
import { BottomPanel, type BottomTab } from './bottom-panel';
import { CodeEditor, type EditorApi } from './code-editor';
import { CommandPalette, type PalettePage } from './command-palette';
import { downloadTrace } from './console-panels';
import { useFreshness, useIsMac, useLevels, usePieceSession, type Problem } from './hooks';
import { Preview, type PreviewHandle } from './preview';
import { SkyBrowser } from './sky-browser';
import { StatusBar } from './status-bar';
import { Notices, Transport, useStartNotice } from './transport';
import { createProject, listProjects } from './project-actions';
import { useHydrated } from './use-hydrated';
import { CircleQuestionMark, Command, Files, LogIn, Maximize, Orbit, PanelBottom, PanelLeft, PanelRight, Search, Settings, type LucideIcon } from 'lucide-react';
import { Icon } from './icons';
import { button } from '@/src/ui/styles';
import { Brand } from './brand';

export type Template = { slug: string; name: string; source: string; ir: unknown };

type Props = {
  mode: 'project' | 'try';
  /** Breadcrumb parent in the toolbar (doc/ui.md, Design system, Toolbar). */
  parent?: { href: string; label: string } | null;
  project?: { id: string; name: string };
  initialSource: string;
  initialIr?: unknown;
  signedIn: boolean;
  templates?: Template[];
  title?: string;
};

type Side = 'explorer' | 'search' | 'sky';
type Part = 'side' | 'preview' | 'panel';

const LAYOUT_TOGGLES: { part: Part; label: string; glyph: LucideIcon; shortcut: string }[] = [
  { part: 'side', label: 'Side Panel', glyph: PanelLeft, shortcut: 'Mod-b' },
  { part: 'panel', label: 'Bottom Panel', glyph: PanelBottom, shortcut: 'Mod-j' },
  { part: 'preview', label: 'Preview', glyph: PanelRight, shortcut: 'Mod-Alt-b' },
];

const btn = button('secondary', 'sm');

/** Last objects of each followed group, for the validator's `unknown_field` warning. */
function snapshotOf(sky: any): Record<string, { fields: Record<string, unknown> }[]> {
  const out: Record<string, { fields: Record<string, unknown> }[]> = {};
  if (!sky) return out;
  for (const g of sky.followed()) {
    const objs = sky.get(g);
    if (objs.length) out[g] = objs.slice(0, 50).map((o: any) => ({ fields: o.fields }));
  }
  return out;
}

export function Workbench({ mode, project, initialSource, initialIr = null, signedIn, templates = [], title, parent: parentProp }: Props) {
  const parent = parentProp ?? (mode === 'project' ? { href: '/projects', label: 'Projects' } : null);
  const router = useRouter();
  const search = useSearchParams();
  const dev = search.get('dev') === '1';
  const { client } = useSupabase();
  const hydrated = useHydrated();
  const { settings } = useSettings();
  const { session, state } = usePieceSession();
  const isMac = useIsMac();
  const levels = useLevels(session);
  const freshness = useFreshness(session?.sky ?? null);

  const [source, setSource] = useState(initialSource);
  const sourceRef = useRef(initialSource);
  const [buildProblems, setBuildProblems] = useState<Problem[]>([]);
  const [typeProblems, setTypeProblems] = useState<Problem[]>([]);
  const [ir, setIr] = useState<any | null>(null);
  const [save, setSave] = useState<SaveState>(mode === 'try' ? 'scratch' : 'saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tab, setTab] = useState<BottomTab>('console');
  // Layout (doc/ui.md, Editor, Layout): read after mount so the server render matches the first client render.
  const [layout, setLayout] = useState<Record<Part, boolean>>({ ...DEFAULT_LAYOUT });
  useEffect(() => { setLayout(loadLayout(window.localStorage)); }, []);
  const setPart = useCallback((part: Part, v: boolean | ((open: boolean) => boolean)) => setLayout((l) => {
    const next = { ...l, [part]: typeof v === 'function' ? v(l[part]) : v };
    saveLayout(window.localStorage, next);
    return next;
  }), []);
  const panelOpen = layout.panel;
  const setPanelOpen = useCallback((v: boolean | ((open: boolean) => boolean)) => setPart('panel', v), [setPart]);
  const [side, setSide] = useState<Side>('explorer');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [name, setName] = useState(project?.name ?? title ?? 'piece');
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [savingAs, setSavingAs] = useState(false);
  const editor = useRef<EditorApi | null>(null);
  const preview = useRef<PreviewHandle>(null);
  const lastRun = useMemo(() => createLastRunStore(typeof window === 'undefined' ? null : window.localStorage), []);

  /** Builds the current source; on success loads (and hot-reloads) the IR. */
  const build = useCallback(async (text: string) => {
    if (!session) return null;
    const snapshot = snapshotOf(session.sky);
    const r = acceptBuild(await session.sandbox.build(text, DEFS, { snapshot }), (built) => validateIr(built, DEFS, { snapshot }));
    setBuildProblems(r.problems);
    if (r.ir) {
      setIr(r.ir);
      session.load(r.ir);
      return r.ir;
    }
    setTab('problems');
    setPanelOpen(true);
    return null;
  }, [session]);

  // First build: load the stored IR at once (so Run works before the sandbox answers), then build.
  useEffect(() => {
    if (!session) return;
    if (initialIr) {
      const r = loadIr(initialIr, DEFS);
      if (r.ir && !blocking(r.problems)) { setIr(r.ir); session.load(r.ir); }
    }
    build(sourceRef.current);
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // Autosave (project mode): source and IR 2 s after the last edit. One per project: `build` and
  // `client` change while the page loads, so they are read through refs, and a pending edit is
  // never dropped with a replaced autosave.
  const buildRef = useRef(build);
  const clientRef = useRef(client);
  useEffect(() => { buildRef.current = build; clientRef.current = client; }, [build, client]);
  const projectId = project?.id ?? null;
  const autosave = useMemo(() => {
    if (mode !== 'project' || !projectId) return null;
    return createAutosave<string>({
      isOnline: () => typeof navigator === 'undefined' || navigator.onLine,
      onChange: (s) => { setSave(s.state); setSaveError(s.error); },
      save: async (text) => {
        const client = clientRef.current;
        if (!client) throw new Error('The database is unavailable');
        const built = await buildRef.current(text);
        const now = new Date().toISOString();
        const row: Record<string, unknown> = { source: text, updated_at: now };
        if (built) { row.ir = built; row.ir_version = built.irVersion ?? 1; row.local_only = !!built.localOnly; }
        const { error } = await client.from('projects').update(row).eq('id', projectId);
        if (error) throw new Error(error.message);
        if (built) await syncSubscriptions(client, projectId, built.groups ?? []);
      },
    });
  }, [mode, projectId]);
  useEffect(() => () => autosave?.dispose(), [autosave]);
  useEffect(() => {
    const on = () => autosave?.connectivity();
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', on); };
  }, [autosave]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (autosave?.hasPending()) { e.preventDefault(); } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [autosave]);

  // Try mode rebuilds 2 s after the last edit without saving.
  const tryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (tryTimer.current) clearTimeout(tryTimer.current); }, []);
  const onChange = useCallback((text: string) => {
    sourceRef.current = text;
    setSource(text);
    if (autosave) autosave.edit(text);
    else {
      if (tryTimer.current) clearTimeout(tryTimer.current);
      tryTimer.current = setTimeout(() => build(text), 2000);
    }
  }, [autosave, build]);

  const saveNow = useCallback(() => {
    if (autosave) return autosave.flush();
    return build(sourceRef.current);
  }, [autosave, build]);

  const runtimeProblems = state.runtimeProblems;
  const problems = useMemo(() => [...buildProblems, ...(runtimeProblems ?? []), ...typeProblems], [buildProblems, runtimeProblems, typeProblems]);
  const canRun = !!ir && !blocking(buildProblems) && state.ready;
  const runNow = useCallback(() => {
    if (!session || !session.ir) return;
    session.run().catch(() => {});
    if (project) lastRun.set(project.id, Date.now());
  }, [session, project, lastRun]);
  const { request: requestRun, dialog: runDialog } = useStartNotice(runNow);

  // Keyboard shortcuts (doc/ui.md, Keyboard shortcuts), in the capture phase so CodeMirror's own
  // bindings for the same keys do not run.
  const escape = useMemo(() => createDoublePress(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !paletteOpen) {
        if (escape.press(performance.now())) session?.panic();
        return;
      }
      const action = shortcutFor(e, SHORTCUTS, isMac);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      switch (action) {
        case 'run': if (canRun) requestRun(); break;
        case 'stop': session?.stop(); break;
        case 'save': saveNow(); break;
        case 'palette': setPaletteOpen(true); break;
        case 'togglePanel': setPanelOpen((o) => !o); break;
        case 'toggleSide': setPart('side', (o) => !o); break;
        case 'togglePreview': setPart('preview', (o) => !o); break;
        case 'focusEditor': editor.current?.focus(); break;
        case 'focusPreview': preview.current?.focus(); break;
        case 'reference': window.open('/learn/reference', '_blank', 'noopener'); break;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isMac, canRun, requestRun, session, saveNow, paletteOpen, escape, setPanelOpen, setPart]);

  const showTab = (t: BottomTab) => { setTab(t); setPanelOpen(true); };

  const newProjectPage = useCallback((): PalettePage => ({
    placeholder: 'New project from a template',
    items: [{ id: 'blank', title: 'Blank' }, ...templates.map((t) => ({ id: t.slug, title: t.name, detail: 'starter' }))],
    onPick: async (item) => {
      if (!client) throw new Error('The database is unavailable');
      const existing = (await listProjects(client)).map((p) => p.name);
      const t = templates.find((x) => x.slug === item.id);
      const id = await createProject(client, { name: uniqueName(t ? t.name : 'Untitled', existing), source: t ? t.source : BLANK_SOURCE, ir: t ? t.ir : null });
      router.push(`/projects/${id}`);
    },
  }), [client, templates, router]);

  const root = useMemo<PalettePage>(() => ({
    placeholder: 'Type a command',
    items: availableCommands(COMMANDS, { piece: true, project: mode === 'project', signedIn }).map((c) => ({ id: c.id, title: c.title, shortcut: c.shortcut })),
    onPick: (item) => {
      switch (item.id) {
        case 'run': if (canRun) requestRun(); return;
        case 'stop': session?.stop(); return;
        case 'panic': session?.panic(); return;
        case 'save': saveNow(); return;
        case 'toggle-console': showTab('console'); return;
        case 'toggle-problems': showTab('problems'); return;
        case 'toggle-ir': showTab('ir'); return;
        case 'toggle-trace': showTab('trace'); return;
        case 'toggle-side': setPart('side', (o) => !o); return;
        case 'toggle-preview': setPart('preview', (o) => !o); return;
        case 'toggle-bottom': setPanelOpen((o) => !o); return;
        case 'go-live': session?.goLive(); return;
        case 'download-trace': downloadTrace(); return;
        case 'open-settings': window.open('/settings', '_blank', 'noopener'); return;
        case 'open-guide': window.open('/learn', '_blank', 'noopener'); return;
        case 'run-fullscreen':
          if (project) Promise.resolve(saveNow()).finally(() => router.push(`/projects/${project.id}/run`));
          return;
        case 'new-project': return newProjectPage();
        case 'open-project': return {
          placeholder: 'Open project',
          items: async () => (client ? (await listProjects(client)).map((p) => ({ id: p.id, title: p.name })) : []),
          onPick: (p) => { router.push(`/projects/${p.id}`); },
        };
        case 'replay': return {
          placeholder: 'Replay window',
          items: REPLAY_WINDOWS.map((w) => ({ id: String(w.ms), title: w.label })),
          onPick: (w) => ({
            placeholder: 'Replay speed',
            items: [1, 10, 100, 1000].map((s) => ({ id: String(s), title: `${s}×` })),
            onPick: async (s) => { await session?.replay({ windowMs: Number(w.id), speed: Number(s.id) }); },
          }),
        };
      }
    },
  }), [mode, signedIn, canRun, requestRun, session, saveNow, project, router, client, newProjectPage, setPart, setPanelOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const rename = async () => {
    const next = (nameDraft ?? '').trim();
    setNameDraft(null);
    if (!project || !client || next === name) return;
    const err = nameError(next);
    if (err) { setSaveError(err); return; }
    const { error } = await client.from('projects').update({ name: next, updated_at: new Date().toISOString() }).eq('id', project.id);
    if (error) setSaveError(`Rename failed: ${error.message}`); else setName(next);
  };

  const saveAsProject = async () => {
    if (!client) return;
    setSavingAs(true);
    try {
      const built = await build(sourceRef.current);
      const existing = (await listProjects(client)).map((p) => p.name);
      const id = await createProject(client, { name: uniqueName(name, existing), source: sourceRef.current, ir: built });
      router.push(`/projects/${id}`);
    } catch (err) {
      setSaveError((err as Error).message);
      setSavingAs(false);
    }
  };

  const followedSources = state.followed.map((g) => sourceOf(g) ?? g);
  const tz = settings.data.timeZone;
  const activity: { id: Side | 'guide' | 'settings'; glyph: LucideIcon; label: string }[] = [
    { id: 'explorer', glyph: Files, label: 'Explorer' }, { id: 'search', glyph: Search, label: 'Search' }, { id: 'sky', glyph: Orbit, label: 'Sky' },
    { id: 'guide', glyph: CircleQuestionMark, label: 'Guide' }, { id: 'settings', glyph: Settings, label: 'Settings' },
  ];

  return (
    <div data-palette="color" className="flex h-screen flex-col overflow-hidden">
      <header className="flex h-9 min-w-0 shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
        <Brand size="sm" />
        <span aria-hidden="true">/</span>
        {parent && <><Link href={parent.href} className="shrink-0 whitespace-nowrap hover:underline">{parent.label}</Link><span aria-hidden="true">/</span></>}
        <h1 className="min-w-0 truncate font-medium">{mode === 'try' ? `Try: ${name}` : name}</h1>
        <span className="flex-1" />
        {mode === 'try' && (signedIn
          ? <button type="button" className={btn} onClick={saveAsProject} disabled={savingAs || !client}>{savingAs ? 'Saving…' : 'Save as Project'}</button>
          : <Link className={btn} href={`/sign-in?redirect_url=${encodeURIComponent(hydrated ? window.location.pathname + window.location.search : '/try')}`}><Icon as={LogIn} size={12} />Sign In to Save</Link>)}
        {mode === 'project' && project && <Link className={btn} href={`/projects/${project.id}/run`} onClick={() => { saveNow(); }}><Icon as={Maximize} size={12} />Run Fullscreen</Link>}
        <div role="group" aria-label="Layout" className="flex shrink-0 items-center gap-0.5">
          {LAYOUT_TOGGLES.map((t) => (
            <button key={t.part} type="button" aria-pressed={layout[t.part]} aria-label={`Show ${t.label}`}
              title={`${layout[t.part] ? 'Hide' : 'Show'} ${t.label} (${formatShortcut(t.shortcut, isMac)})`}
              onClick={() => setPart(t.part, (o) => !o)}
              className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm ${layout[t.part] ? 'bg-fg text-bg' : 'hover:bg-fg hover:text-bg'}`}>
              <Icon as={t.glyph} size={14} />
            </button>
          ))}
        </div>
        <button type="button" className={btn} onClick={() => setPaletteOpen(true)} title="Command palette (Mod-Shift-P, Mod-K)"><Icon as={Command} size={12} />Commands</button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Activity bar" className="flex w-11 shrink-0 flex-col items-center gap-1.5 border-r border-line py-1.5">
          {activity.map((a) => {
            const active = layout.side && side === a.id;
            const onClick = () => {
              if (a.id === 'guide') window.open('/learn', '_blank', 'noopener');
              else if (a.id === 'settings') window.open('/settings', '_blank', 'noopener');
              else if (active) setPart('side', false);
              else { setSide(a.id as Side); setPart('side', true); }
            };
            return (
              <button key={a.id} type="button" title={a.label} aria-label={a.label} aria-pressed={active} onClick={onClick}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-sm ${active ? 'bg-fg text-bg' : 'hover:bg-fg hover:text-bg'}`}><Icon as={a.glyph} size={16} /></button>
            );
          })}
        </nav>
        <aside className={`${layout.side ? 'md:block' : ''} hidden w-60 shrink-0 overflow-y-auto border-r border-line p-3`} aria-label={side}>
          {side === 'explorer' && (
            <div className="font-mono text-xs">
              <div className="mb-1 text-fg-muted">Explorer</div>
              {mode === 'project' && (nameDraft === null
                ? <button type="button" className="mb-1 block w-full truncate text-left hover:underline" title="Rename" onClick={() => setNameDraft(name)}>{name}</button>
                : <input autoFocus className="mb-1 w-full border border-line bg-bg px-1" value={nameDraft} aria-label="Project name"
                    onChange={(e) => setNameDraft(e.target.value)} onBlur={rename} onKeyDown={(e) => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') setNameDraft(null); }} />)}
              <button type="button" className="block w-full bg-fg px-1 text-left text-bg" onClick={() => editor.current?.focus()}>piece.ts</button>
              <div className="mt-3 mb-1 text-fg-muted">Sky</div>
              <SkyBrowser sky={session?.sky ?? null} followed={state.followed} onInsert={(t) => editor.current?.insert(t)} />
            </div>
          )}
          {side === 'sky' && <SkyBrowser sky={session?.sky ?? null} followed={state.followed} onInsert={(t) => editor.current?.insert(t)} />}
          {side === 'search' && <SourceSearch source={source} onGoto={(l) => editor.current?.goto(l)} />}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5">
            <Transport session={session} state={state} onRun={runNow} canRun={canRun} runHint={canRun ? null : 'Fix the errors in Problems to run'}
              maxDb={settings.audio.maxMasterDb} startDb={settings.audio.masterDb} />
          </div>
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <main className="flex min-w-0 flex-1 flex-col" aria-label="Editor">
              <div className="flex min-h-8 items-center border-b border-line px-3 py-1">
                <span className="font-mono text-xs">piece.ts</span>
              </div>
              <div className="min-h-0 flex-1">
                <CodeEditor
                  initialValue={initialSource}
                  onChange={onChange}
                  buildProblems={buildProblems}
                  onTypeProblems={setTypeProblems}
                  onReady={(api) => { editor.current = api; }}
                  fontSize={settings.editor.fontSize}
                  theme={settings.editor.theme as 'dark' | 'light'}
                />
              </div>
            </main>
            <section aria-label="Preview" hidden={!layout.preview} className="flex h-[45%] w-full flex-col border-t border-line md:h-auto md:w-[38%] md:min-w-64 md:border-t-0 md:border-l">
              <div className="flex min-h-8 items-center border-b border-line px-3 py-1">
                <span className="text-xs">Preview</span>
              </div>
              <Preview ref={preview} session={session} state={state} className="flex-1" />
              <div className="border-t border-line p-1"><Notices session={session} state={state} /></div>
            </section>
          </div>
          {panelOpen && (
            <div className="h-[34%] min-h-32">
              <BottomPanel tab={tab} onTab={setTab} session={session} state={state} client={client} problems={problems} ir={ir}
                onGoto={(l) => editor.current?.goto(l)} timeZone={tz} dev={dev} replaySpeed={settings.data.replaySpeed} />
            </div>
          )}
        </div>
      </div>
      <StatusBar
        sources={statusSources(freshness, followedSources)}
        timeZone={tz}
        audio={state.audio}
        voices={levels.voices}
        levelDb={levels.peakDb}
        limiting={levels.limiting}
        save={save}
        saveError={saveError}
        mode={state.mode}
        replaySpeed={state.replay?.speed ?? null}
        note={state.visualsAvailable === false ? 'Visuals unavailable (WebGL2)' : settings.editor.keymap === 'vim' ? 'Vim keymap unavailable' : null}
      />
      {saveError && <p role="alert" className="sr-only">{saveError}</p>}
      <CommandPalette open={paletteOpen} root={root} onClose={() => setPaletteOpen(false)} isMac={isMac} />
      {runDialog}
    </div>
  );
}

function SourceSearch({ source, onGoto }: { source: string; onGoto: (line: number) => void }) {
  const [q, setQ] = useState('');
  const hits = useMemo(() => {
    if (!q) return [];
    const needle = q.toLowerCase();
    return source.split('\n').map((text, i) => ({ line: i + 1, text })).filter((l) => l.text.toLowerCase().includes(needle)).slice(0, 200);
  }, [q, source]);
  return (
    <div className="font-mono text-xs">
      <div className="mb-1 text-fg-muted">Search</div>
      <input className="mb-2 w-full border border-line bg-bg px-1" placeholder="Search piece.ts" aria-label="Search piece.ts" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul>
        {q && hits.length === 0 && <li className="text-fg-muted">No matches</li>}
        {hits.map((h) => (
          <li key={h.line}><button type="button" className="block w-full truncate text-left hover:bg-fg hover:text-bg" onClick={() => onGoto(h.line)}><span className="text-fg-muted">{h.line}</span> {h.text.trim()}</button></li>
        ))}
      </ul>
    </div>
  );
}
