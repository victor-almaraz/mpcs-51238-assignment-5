// Autosave state machine (doc/ui.md, Editor): writes 2 s after the last edit; states Saved,
// Saving…, Unsaved changes, Offline. One save runs at a time; edits during a save schedule
// another. Timers and the online check are injected for tests.

export const AUTOSAVE_DELAY_MS = 2000;
export const RETRY_MAX_MS = 30000;

/**
 * @typedef {'saved' | 'saving' | 'unsaved' | 'offline'} AutosaveState
 * @typedef {{ state: AutosaveState, error: string | null }} AutosaveStatus
 */

/**
 * @template T
 * @param {{
 *   save: (value: T) => Promise<void>,
 *   delayMs?: number,
 *   timers?: { setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (id: any) => void },
 *   isOnline?: () => boolean,
 *   onChange?: (status: AutosaveStatus) => void,
 * }} opts
 */
export function createAutosave({
  save, delayMs = AUTOSAVE_DELAY_MS,
  timers = { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) },
  isOnline = () => true, onChange = () => {},
}) {
  /** @type {AutosaveState} */
  let state = 'saved';
  /** @type {string | null} */
  let error = null;
  /** @type {{ value: T } | null} latest unsaved value */
  let pending = null;
  let saving = false;
  let timer = null;
  let retryMs = delayMs;
  let disposed = false;

  const set = (/** @type {AutosaveState} */ s, /** @type {string | null} */ e = null) => {
    if (s === state && e === error) return;
    state = s;
    error = e;
    onChange({ state, error });
  };

  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };

  const schedule = (/** @type {number} */ ms) => {
    clear();
    timer = timers.setTimeout(() => { timer = null; run(); }, ms);
  };

  async function run() {
    if (disposed || saving || !pending) return;
    if (!isOnline()) { set('offline'); return; }
    const job = pending;
    pending = null;
    saving = true;
    set('saving');
    try {
      await save(job.value);
      retryMs = delayMs;
      saving = false;
      if (disposed) return;
      if (pending) { set('unsaved'); schedule(delayMs); } else set('saved');
    } catch (err) {
      saving = false;
      if (disposed) return;
      pending ??= job;
      const message = err instanceof Error ? err.message : String(err);
      if (!isOnline()) { set('offline', message); return; }
      set('unsaved', message);
      schedule(retryMs);
      retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
    }
  }

  return {
    /** Records an edit; the save runs `delayMs` after the last one. @param {T} value */
    edit(value) {
      if (disposed) return;
      pending = { value };
      set(isOnline() ? 'unsaved' : 'offline', null);
      if (!saving) schedule(delayMs);
    },
    /** Saves now (Mod-S) when there is an unsaved value. */
    flush() {
      clear();
      return run();
    },
    /** Call on the `online` and `offline` window events. */
    connectivity() {
      if (disposed) return;
      if (!isOnline()) { if (pending) set('offline', error); return; }
      if (pending && !saving) { set('unsaved', error); run(); }
    },
    status() { return { state, error }; },
    hasPending() { return pending !== null || saving; },
    dispose() { disposed = true; clear(); },
  };
}
