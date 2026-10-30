// Owns the single live AudioContext (audio-engine-core.md). Imported only from client
// components; nothing here touches window, navigator or AudioContext at import time.
// The context is created lazily inside a user-gesture handler and resumed synchronously.

let ctx = null;
const listeners = new Set();

function notify(state) {
  for (const fn of listeners) {
    try { fn(state); } catch { /* a listener error must not break the others */ }
  }
}

/** navigator.audioSession (Safari 16.4+); 'playback' bypasses the iOS ringer switch (iOS 17+). */
export function audioSessionSupported() {
  return typeof navigator !== 'undefined' && 'audioSession' in navigator && navigator.audioSession != null;
}

/**
 * Creates the context on first call and resumes it. resume() runs synchronously, before any
 * await, so it keeps user activation. → Promise<AudioContext> resolving after resume.
 */
export function ensureRunning() {
  try {
    if (!ctx) {
      if (audioSessionSupported()) {
        try { navigator.audioSession.type = 'playback'; } catch { /* unsupported value */ }
      }
      const c = new AudioContext({ latencyHint: 'interactive' });
      c.addEventListener('statechange', () => { if (ctx === c) notify(c.state); });
      ctx = c;
    }
    const c = ctx;
    const resumed = c.state !== 'running' ? c.resume() : Promise.resolve();
    return resumed.then(() => {
      if (ctx === c) notify(c.state);   // in case the engine fired no statechange (already running)
      return c;
    });
  } catch (err) {
    return Promise.reject(err);
  }
}

export function getContext() {
  return ctx;
}

/** fn(state) on every state change of the current context; survives recreation. → unsubscribe. */
export function onContextState(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Closes and forgets the context ("Restart Audio"). The next gesture creates a new one. */
export function closeContext() {
  const c = ctx;
  if (!c) return Promise.resolve();
  ctx = null;
  const done = c.state === 'closed' ? Promise.resolve() : c.close().catch(() => {});
  return done.then(() => { if (ctx === null) notify('closed'); });
}
