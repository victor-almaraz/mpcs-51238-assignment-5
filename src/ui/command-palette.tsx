'use client';

// Command palette (doc/ui.md, Command palette): a modal list filtered by fuzzy match. Picking an
// item either runs it or opens a sub-list (templates, projects, replay window and speed).

import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyFilter } from '@/src/ui/palette.js';
import { formatShortcut } from '@/src/ui/shortcuts.js';
import { useDialogFocus } from './use-dialog-focus';

export type PaletteItem = { id: string; title: string; detail?: string; shortcut?: string };
export type PalettePage = {
  placeholder: string;
  items: PaletteItem[] | (() => Promise<PaletteItem[]>);
  onPick: (item: PaletteItem) => PalettePage | void | Promise<PalettePage | void>;
};

export function CommandPalette({ open, root, onClose, isMac }: { open: boolean; root: PalettePage; onClose: () => void; isMac: boolean }) {
  const [stack, setStack] = useState<PalettePage[]>([root]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [items, setItems] = useState<PaletteItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const trap = useDialogFocus(box);
  const page = stack[stack.length - 1];

  useEffect(() => {
    if (!open) return;
    setStack([root]);
    setQuery('');
    setActive(0);
    const t = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, root]);

  useEffect(() => {
    let stopped = false;
    setError(null);
    if (Array.isArray(page.items)) { setItems(page.items); return; }
    setItems(null);
    page.items().then((v) => { if (!stopped) setItems(v); }, (err: Error) => { if (!stopped) { setItems([]); setError(err.message); } });
    return () => { stopped = true; };
  }, [page]);

  const shown = useMemo(() => (items ? fuzzyFilter(items, query, (i) => i.title) : []), [items, query]);
  useEffect(() => { setActive(0); }, [query, page]);

  if (!open) return null;

  const pick = async (item: PaletteItem | undefined) => {
    if (!item) return;
    try {
      const next = await page.onPick(item);
      if (next) { setStack((s) => [...s, next]); setQuery(''); } else onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(shown[active]); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (stack.length > 1) { setStack((s) => s.slice(0, -1)); setQuery(''); } else onClose();
    } else if (e.key === 'Backspace' && query === '' && stack.length > 1) {
      setStack((s) => s.slice(0, -1));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/40 pt-24" onMouseDown={onClose}>
      <div ref={box} onKeyDown={trap} role="dialog" aria-modal="true" aria-label="Command palette" className="h-fit w-full max-w-lg rounded-sm border border-line bg-panel text-sm" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={page.placeholder}
          aria-label={page.placeholder}
          aria-controls="palette-list"
          aria-activedescendant={shown[active] ? `palette-${shown[active].id}` : undefined}
          className="w-full border-b border-line bg-transparent px-3 py-2 outline-none"
        />
        <ul id="palette-list" role="listbox" className="max-h-80 overflow-y-auto py-1">
          {items === null && <li className="px-3 py-1 text-fg-muted">Loading…</li>}
          {error && <li className="px-3 py-1 text-error">{error}</li>}
          {items !== null && shown.length === 0 && !error && <li className="px-3 py-1 text-fg-muted">No matches</li>}
          {shown.map((item, i) => (
            <li
              key={item.id}
              id={`palette-${item.id}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(item)}
              className={`flex cursor-pointer items-baseline gap-3 px-3 py-1 ${i === active ? 'bg-panel-2' : ''}`}
            >
              <span className="flex-1">{item.title}</span>
              {item.detail && <span className="text-xs text-fg-muted">{item.detail}</span>}
              {item.shortcut && <kbd className="text-xs text-fg-muted">{formatShortcut(item.shortcut, isMac)}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
