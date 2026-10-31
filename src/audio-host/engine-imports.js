// The only module that imports the user's audio engine (AGENTS.md, Division of labor).
// Everything else in src/audio-host/ and src/bind/ receives these through injection.
//
// Paths and names:
// - `ensureRunning`, `closeContext` from src/audio/context.js: doc/audio/audio-engine-core.md.
// - `buildMasterBus` from src/audio/master-bus.js: doc/audio/audio-safety.md, Wiring.
// - `Engine` from src/audio/engine.js: the class that `buildEngine` constructs.
//
// Import this module only from 'use client' components; it must not run during prerendering.

export { ensureRunning, closeContext } from '../audio/context.js';
export { buildMasterBus } from '../audio/master-bus.js';
export { Engine } from '../audio/engine.js';
