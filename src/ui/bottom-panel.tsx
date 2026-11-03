'use client';

// Bottom panel (doc/ui.md, Editor): Console, Problems, IR (read-only compiled JSON), Trace.
// The Console tab holds the console panels of doc/console.md, the replay controls and, with
// `?dev=1`, the synthetic trigger panel (doc/sky-contract.md, Synthetic triggers).

import { memo, useState } from 'react';
import { GROUPS, groupKeys } from '@/src/sky/groups.js';
import {
  ConsoleControls, EffectsPanel, EventsPanel, ModulationPanel, ProblemsPanel, SourcesPanel, TracePanel, VoicesPanel,
} from './console-panels';
import { ReplayControls } from './replay-controls';
import { useHydrated } from './use-hydrated';
import { CircleX, TriangleAlert } from 'lucide-react';
import { Icon } from './icons';
import { useTraceRecords, type Freshness, type PieceSession, type Problem, type SessionState } from './hooks';
import { button, inputSm, tab as tabClass } from '@/src/ui/styles';

export type BottomTab = 'console' | 'problems' | 'ir' | 'trace';
const TABS: { id: BottomTab; label: string }[] = [
  { id: 'console', label: 'Console' }, { id: 'problems', label: 'Problems' }, { id: 'ir', label: 'IR' }, { id: 'trace', label: 'Trace' },
];
const SUBTABS = ['Sources', 'Events', 'Voices', 'Modulation', 'Effects'] as const;
const btn = button('secondary', 'sm');

function BottomPanelView({ tab, onTab, session, state, client, freshness, problems, ir, onGoto, timeZone, dev = false, replaySpeed = 100 }: {
  tab: BottomTab; onTab: (t: BottomTab) => void; session: PieceSession | null; state: SessionState; client: any | null;
  /** The editor's freshness, so the page polls the sky store once. */
  freshness: Freshness[];
  problems: Problem[]; ir: any | null; onGoto?: (line: number) => void; timeZone: string; dev?: boolean; replaySpeed?: number;
}) {
  const [paused, setPaused] = useState(false);
  const [sub, setSub] = useState<(typeof SUBTABS)[number] | 'Synthetic'>('Events');
  const [selected, setSelected] = useState<string | null>(null);
  const records = useTraceRecords(paused);
  const hydrated = useHydrated();
  const errors = problems.filter((p) => p.severity === 'error').length;
  const warnings = problems.length - errors;
  const select = (id: string) => { setSelected(id); };

  return (
    <section aria-label="Bottom panel" className="flex h-full min-h-0 flex-col border-t border-line bg-panel">
      <div role="tablist" aria-label="Bottom panel tabs" className="flex items-center gap-1 border-b border-line px-2 text-xs">
        {TABS.map((t) => (
          <button
            key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} id={`tab-${t.id}`}
            onClick={() => onTab(t.id)}
            className={tabClass(tab === t.id)}
          >
            {t.label}{t.id === 'problems' && problems.length ? <span className="ml-1 inline-flex items-center gap-1 align-middle">
              {errors ? <span className="inline-flex items-center gap-0.5 text-error"><Icon as={CircleX} size={12} />{errors}<span className="sr-only"> errors</span></span> : null}
              {warnings ? <span className="inline-flex items-center gap-0.5 text-warn"><Icon as={TriangleAlert} size={12} />{warnings}<span className="sr-only"> warnings</span></span> : null}
            </span> : null}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="min-h-0 flex-1 overflow-auto p-2">
        {tab === 'console' && (
          <div className="flex h-full min-h-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <div role="tablist" aria-label="Console panels" className="flex gap-1 text-xs">
                {[...SUBTABS, ...(dev ? (['Synthetic'] as const) : [])].map((s) => (
                  <button key={s} type="button" role="tab" aria-selected={sub === s} onClick={() => setSub(s)} className={`px-1.5 ${sub === s ? 'bg-fg text-bg' : 'hover:bg-fg hover:text-bg'}`}>{s}</button>
                ))}
              </div>
              <ConsoleControls paused={paused} onPause={setPaused} />
              <ReplayControls session={session} mode={state.mode} replay={state.replay} defaultSpeed={replaySpeed} disabled={!hydrated || !client} />
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {sub === 'Sources' && <SourcesPanel client={client} freshness={freshness} timeZone={timeZone} />}
              {sub === 'Events' && <EventsPanel records={records} followed={state.followed} groups={groupKeys()} timeZone={timeZone} paused={paused} onSelect={(id) => { select(id); onTab('trace'); }} selected={selected} />}
              {sub === 'Voices' && <VoicesPanel session={session} />}
              {sub === 'Modulation' && <ModulationPanel session={session} />}
              {sub === 'Effects' && <EffectsPanel session={session} records={records} />}
              {sub === 'Synthetic' && dev && <SyntheticPanel session={session} />}
            </div>
          </div>
        )}
        {tab === 'problems' && <ProblemsPanel problems={problems} onGoto={onGoto} />}
        {tab === 'ir' && (ir
          ? <pre aria-label="Compiled IR (read-only)" className="font-mono text-xs">{JSON.stringify(ir, null, 2)}</pre>
          : <p className="text-xs text-fg-muted">No compiled IR. Fix the problems in Problems to build the piece.</p>)}
        {tab === 'trace' && <TracePanel records={records} selected={selected} onSelect={select} timeZone={timeZone} />}
      </div>
    </section>
  );
}

function SyntheticPanel({ session }: { session: PieceSession | null }) {
  const groups = groupKeys();
  const [group, setGroup] = useState(groups[0]);
  const [key, setKey] = useState('test1');
  const [fields, setFields] = useState('{}');
  const [source, setSource] = useState(GROUPS[groups[0]].source);
  const [fstate, setFstate] = useState('stale');
  const [msg, setMsg] = useState<string | null>(null);
  const syn = () => {
    const s = session?.synthetic();
    if (!s) throw new Error('Synthetic events need the live store (leave replay first)');
    return s;
  };
  const run = (fn: () => unknown) => {
    try { const r = fn(); setMsg(typeof r === 'string' ? `ok: ${r}` : 'ok'); } catch (err) { setMsg((err as Error).message); }
  };
  const parsed = () => JSON.parse(fields || '{}');
  return (
    <div className="flex flex-col gap-2 font-mono text-xs">
      <p className="text-fg-muted">Fabricated events change only this tab&apos;s store and never write to the database.</p>
      <div className="flex flex-wrap items-center gap-2">
        <select className={inputSm} value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group">{groups.map((g) => <option key={g}>{g}</option>)}</select>
        <input className={`${inputSm} w-28`} value={key} onChange={(e) => setKey(e.target.value)} aria-label="Object key" />
        <input className={`${inputSm} min-w-48 flex-1`} value={fields} onChange={(e) => setFields(e.target.value)} aria-label="Fields JSON" />
        <button type="button" className={btn} onClick={() => run(() => syn().enter(group, key, parsed()))}>Enter</button>
        <button type="button" className={btn} onClick={() => run(() => syn().update(`${group}:${key}`, parsed()))}>Update</button>
        <button type="button" className={btn} onClick={() => run(() => syn().exit(`${group}:${key}`))}>Exit</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className={inputSm} value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
          {[...new Set(groups.map((g) => GROUPS[g].source))].map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className={inputSm} value={fstate} onChange={(e) => setFstate(e.target.value)} aria-label="Freshness">
          {['fresh', 'stale', 'down', 'loading'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <button type="button" className={btn} onClick={() => run(() => syn().freshness(source, fstate))}>Set Freshness</button>
        <button type="button" className={btn} onClick={() => run(() => syn().freshness(source, null))}>Release</button>
        <button type="button" className={btn} onClick={() => run(() => { syn().clear(); })}>Clear Synthetic</button>
      </div>
      {msg && <p role="status">{msg}</p>}
    </div>
  );
}

/** Memoized: the workbench re-renders on every keystroke, and the panel's lists are long. */
export const BottomPanel = memo(BottomPanelView);
