// The only module that imports the user's audio engine (AGENTS.md, Division of labor).
// Everything else in src/audio-host/ and src/bind/ receives these through injection.
//
// Paths and names:
// - `ensureRunning` from src/audio/context.js: doc/audio/audio-engine-core.md.
// - `buildMasterBus` from src/audio/master-bus.js: doc/audio/audio-safety.md, Wiring.
// - `Engine` from src/audio/engine.js: ASSUMPTION. doc/bindings.md (Audio host) constructs
//   `new Engine(ctx, bus, opts)`, and doc/audio/audio-engine-core.md places the engine in
//   src/audio/engine.js but documents only `buildEngine(ctx, seed)` there. Confirm the class
//   export name with the user.
//
// Import this module only from 'use client' components; it must not run during prerendering.

export { ensureRunning } from '../audio/context.js';
export { buildMasterBus } from '../audio/master-bus.js';
export { Engine } from '../audio/engine.js';
