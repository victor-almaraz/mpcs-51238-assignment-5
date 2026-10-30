# Documentation index

## Scope
Index and reading order for the Sphärenmusik docs. Each doc opens with a Scope section and closes with a Sources section.

## Project docs
| Doc | Subject |
|---|---|
| `architecture.md` | Components, interfaces, data-flow chart, trace of one change |
| `sources.md` | External sources, source registry, normalization |
| `worker.md` | Railway worker process, pipeline, logs, deployment |
| `database.md` | Tables, RPC, row-level security, Realtime publication, retention, budget |
| `auth.md` | Clerk, Clerk–Supabase third-party auth, Supabase clients, keys |
| `sky-contract.md` | Browser sky store, events, freshness, replay, synthetic triggers |
| `piece-dsl.md` | Builder API, expressions, IR schema, validation, sandbox, hot reload |
| `bindings.md` | Binding runtime and the instrument contracts |
| `visuals.md` | Layers, projections, renderer, SGP4 worker, A/V sync, visual safety |
| `console.md` | Trace records, panels, export |
| `ui.md` | Routes, screens, states, shortcuts, settings |
| `guide.md` | The `/learn` user guide page: content, rendering, Try mode, consistency tests |
| `testing.md` | Automated tests and manual checklist |
| `deployment.md` | Services, environment variables, free-tier limits |

## Audio engine docs
`audio/` holds the engine reference: `audio-engine-core.md`, `audio-safety.md`, `audioworklet.md`, `recording.md`, `patch-format.md`, the `synthesis-*.md` files, `effects.md` (effect kernels and chains, from assignment 3) and `modulation.md` (LFOs and data modulation). Those docs describe the engine's internal rules and bind the user's code. They reference MIDI, live-input and layout docs from assignment 2; MIDI files, live input and the synth rack UI are outside this project.

## User guide
`content/learn/` holds the user guide: Markdown pages for people learning the piece script, rendered at `/learn` (`guide.md`). The guide is product content; these docs are for implementers.

## Reading order
1. `architecture.md`
2. `sources.md`, `worker.md`, `database.md`, `auth.md`
3. `sky-contract.md`
4. `piece-dsl.md`, `bindings.md`, `audio/audio-engine-core.md`, `audio/audio-safety.md`, `audio/effects.md`, `audio/modulation.md`
5. `visuals.md`, `console.md`, `ui.md`, `guide.md`
6. `testing.md`, `deployment.md`

## Sources
- MPCS 51238 Assignment 5 brief.
