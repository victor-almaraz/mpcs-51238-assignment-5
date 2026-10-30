// Loads the AudioWorklet modules once per context, AudioContext and OfflineAudioContext alike
// (audioworklet.md). Processors live in public/worklets/ outside the bundle and are loaded
// from absolute URLs. Each module is loaded independently so one failure does not mark the
// others failed:
//   safety-limiter fails → master bus uses the fallback stage (audio-safety.md)
//   ks-processor fails   → Pluck is unavailable
//   recorder fails       → Record is disabled; offline render is unaffected

/** Incremented whenever a processor changes (static assets are cached). */
export const WORKLET_VERSION = 1;

const MODULES = [
  ['safety-limiter', 'safety'],
  ['ks-processor', 'ks'],
  ['recorder', 'recorder'],
];

const loaded = new WeakMap();

export function workletUrl(name) {
  return `/worklets/${name}.js?v=${WORKLET_VERSION}`;
}

/** → Promise<{ safety: boolean, ks: boolean, recorder: boolean }>; never rejects. */
export function loadWorklets(ctx) {
  let p = loaded.get(ctx);
  if (p) return p;
  p = (async () => {
    const result = { safety: false, ks: false, recorder: false };
    const worklet = ctx ? ctx.audioWorklet : undefined;   // only exposed in secure contexts
    if (!worklet || typeof worklet.addModule !== 'function') return result;
    for (const [name, key] of MODULES) {
      try {
        await worklet.addModule(workletUrl(name));
        result[key] = true;
      } catch {
        result[key] = false;
      }
    }
    return result;
  })();
  loaded.set(ctx, p);
  return p;
}
