'use client';

// Settings screen (doc/ui.md, Settings): a searchable list grouped by category and an editable
// settings.json view. Both edit one object, validated with validateSettings on every change;
// warnings are shown. Valid changes save to user_settings 1 s after the last edit.

import { useEffect, useMemo, useRef, useState } from 'react';
import { UserProfile } from '@clerk/nextjs';
import { getPath, parseSettingsJson, searchSettings, setPath, settingsJson, type SettingDef } from '@/src/ui/settings-view.js';
import { validateSettings } from '@/src/lib/settings.js';
import { Attribution } from '@/src/ui/attribution';
import { useSettings, type SettingsWarning } from '@/src/ui/app-providers';
import { button, container, heading, input, segmented } from '@/src/ui/styles';
import { SiteHeader } from '@/src/ui/site-header';

const SAVE_DELAY_MS = 1000;
const btn = button('secondary', 'sm');

export function SettingsView() {
  const { settings, warnings: loadWarnings, loaded, error: loadError, save } = useSettings();
  const [draft, setDraft] = useState<any>(settings);
  const [warnings, setWarnings] = useState<SettingsWarning[]>([]);
  const [view, setView] = useState<'list' | 'json'>('list');
  const [query, setQuery] = useState('');
  const [text, setText] = useState(() => settingsJson(settings));
  const [parseError, setParseError] = useState<string | null>(null);
  const [status, setStatus] = useState<'saved' | 'unsaved' | 'saving' | 'error'>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  useEffect(() => {
    if (dirty.current) return;
    setDraft(settings);
    setText(settingsJson(settings));
    setWarnings(loadWarnings);
  }, [settings, loadWarnings]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const schedule = (next: any) => {
    dirty.current = true;
    setStatus('unsaved');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setStatus('saving');
      try {
        await save(next);
        dirty.current = false;
        setStatus('saved');
        setSaveError(null);
      } catch (err) {
        setStatus('error');
        setSaveError((err as Error).message);
      }
    }, SAVE_DELAY_MS);
  };

  const change = (path: string, value: unknown) => {
    const v = validateSettings(setPath(draft, path, value));
    setDraft(v.settings);
    setWarnings(v.warnings);
    setText(settingsJson(v.settings));
    schedule(v.settings);
  };

  const editJson = (t: string) => {
    setText(t);
    const r = parseSettingsJson(t);
    if (!r.ok) { setParseError(r.error); return; }
    setParseError(null);
    setDraft(r.settings);
    setWarnings(r.warnings);
    schedule(r.settings);
  };

  const groups = useMemo(() => searchSettings(query), [query]);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className={`${container.page} flex-1`}>
        <div className="mb-6 flex items-baseline justify-between gap-4">
          <h1 className={heading.page}>Settings</h1>
          <span className="text-xs" role="status">
            {!loaded ? 'Loading…' : status === 'saved' ? 'Saved' : status === 'saving' ? 'Saving…' : status === 'unsaved' ? 'Unsaved changes' : 'Save failed'}
          </span>
        </div>
        {(loadError || saveError) && <p role="alert" className="mb-4 text-xs text-error">{saveError ?? loadError}</p>}
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <input
            type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search settings" aria-label="Search settings"
            disabled={view === 'json'} className={`${input} min-w-64 flex-1`}
          />
          <div role="group" aria-label="View" className={segmented.group}>
            <button type="button" className={segmented.option(view === 'list')} aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
            <button type="button" className={segmented.option(view === 'json')} aria-pressed={view === 'json'} onClick={() => setView('json')}>settings.json</button>
          </div>
        </div>
        {warnings.length > 0 && (
          <ul aria-label="Warnings" className="mb-4 border border-warn p-2 text-xs text-warn">
            {warnings.map((w, i) => <li key={i}>{w.path || 'settings'}: {w.message}</li>)}
          </ul>
        )}
        {!loaded ? (
          <div aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="mb-3 h-8 border border-dashed border-line" />)}</div>
        ) : view === 'list' ? (
          <div className="flex flex-col gap-6">
            {groups.length === 0 && <p className="text-sm text-fg-muted">No setting matches “{query}”.</p>}
            {groups.map((g) => (
              <section key={g.group} aria-labelledby={`settings-${g.group}`}>
                <h2 id={`settings-${g.group}`} className="mb-2 border-b border-line pb-1 font-semibold">{g.group}</h2>
                <ul className="flex flex-col gap-3">
                  {g.items.map((d) => <SettingRow key={d.path} def={d} value={getPath(draft, d.path)} onChange={(v) => change(d.path, v)} maxDb={draft.audio.maxMasterDb} />)}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <div>
            <textarea
              value={text} onChange={(e) => editJson(e.target.value)} spellCheck={false} aria-label="settings.json"
              aria-invalid={parseError ? true : undefined}
              className="h-96 w-full rounded-md border border-line bg-bg p-3 font-mono text-sm"
            />
            {parseError && <p role="alert" className="mt-1 text-xs text-error">Not saved: {parseError}</p>}
          </div>
        )}
        <section aria-labelledby="account" className="mt-10">
          <h2 id="account" className="mb-2 border-b border-line pb-1 font-semibold">Account</h2>
          <UserProfile routing="hash" />
        </section>
      </main>
      <Attribution />
    </div>
  );
}

function SettingRow({ def, value, onChange, maxDb }: { def: SettingDef; value: any; onChange: (v: unknown) => void; maxDb: number }) {
  const id = `setting-${def.path}`;
  let control: React.ReactNode;
  if (def.control === 'select') {
    control = (
      <select id={id} className={`${input} pr-8`} value={String(value)}
        onChange={(e) => { const o = def.options?.find((x) => String(x) === e.target.value); onChange(o); }}>
        {def.options?.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
      </select>
    );
  } else if (def.control === 'number') {
    const max = def.path === 'audio.masterDb' ? maxDb : def.max;
    control = (
      <input id={id} type="number" min={def.min} max={max} step={def.step} value={value ?? ''}
        onChange={(e) => { if (e.target.value !== '') onChange(Number(e.target.value)); }}
        className={`${input} w-28`} />
    );
  } else if (def.control === 'observer') {
    control = (
      <span id={id} className="flex gap-2 text-sm">
        <label>lat <input type="number" min={-90} max={90} step={0.01} value={value?.lat ?? ''} className={`${input} ml-1 w-24`}
          onChange={(e) => onChange({ ...value, lat: Number(e.target.value) })} /></label>
        <label>lon <input type="number" min={-180} max={180} step={0.01} value={value?.lon ?? ''} className={`${input} ml-1 w-24`}
          onChange={(e) => onChange({ ...value, lon: Number(e.target.value) })} /></label>
      </span>
    );
  } else {
    control = <TextSetting id={id} value={String(value ?? '')} onCommit={onChange} />;
  }
  return (
    <li className="grid gap-1 sm:grid-cols-[1fr_auto] sm:items-center">
      <div>
        <label htmlFor={id} className="text-sm">{def.label} <code className="font-mono text-xs text-fg-muted">{def.path}</code></label>
        <p className="text-xs text-fg-muted">{def.description}{def.path === 'editor.keymap' && value === 'vim' ? ' The vim keymap package is not installed; the editor uses the default keymap.' : ''}</p>
      </div>
      {control}
    </li>
  );
}

/** Text input that validates when it loses focus, so partial zone names do not reset. */
function TextSetting({ id, value, onCommit }: { id: string; value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input id={id} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v !== value) onCommit(v); }}
      onKeyDown={(e) => { if (e.key === 'Enter') onCommit(v); }} className={`${input} w-56`} />
  );
}
