# AGENTS.md

## Project description
Sphärenmusik (ASCII form `sphaerenmusik`) is a generative audio-visual web piece driven by live space data. The worker, the Supabase Edge Function `harvest`, runs every minute from a `pg_cron` job and harvests orbital, space-weather, near-Earth-object and launch data into Supabase. A Next.js page receives changes through Supabase Realtime. Users write TypeScript piece scripts in a browser editor. A script is a program that runs in a sandbox worker, its VM: setup opens instruments and layers and returns a JSON intermediate representation (IR), and handlers keep running on sky events and timers, holding state and sending commands. A runtime interprets the IR's bindings and checks every program command, binding sky data to audio instruments and visual layers. A console shows the raw events that drive the output.

The project is MPCS 51238 *Design, Build, Ship*, Assignment 5 *Live Data System*, due Tuesday 2026-11-03 at 17:30 America/Chicago.

## Assignment requirements
| Requirement | Implementation | Doc |
|---|---|---|
| Live source | CelesTrak GP, NOAA SWPC, JPL CAD and Scout, Launch Library 2 | `doc/sources.md` |
| Data-flow chart, made before code | Mermaid chart | `doc/architecture.md` |
| Worker runs all the time, saves only changed rows, records each run | Edge Function `harvest` in `supabase/functions/harvest/`, invoked every minute by `pg_cron`; `worker/` holds the local CLI and fixture tests | `doc/worker.md` |
| Live page without refresh; freshness; loading, fresh, stale and down states | Realtime Postgres Changes, sky store | `doc/sky-contract.md`, `doc/ui.md` |
| Personal choices under row-level security | `project_subscriptions` | `doc/database.md` |
| Deployed page and worker; a classmate can sign in and watch | Vercel Hobby, Supabase Free (Edge Function and `pg_cron`) | `doc/deployment.md` |
| Test on a saved copy of source responses | Fixture tests | `doc/testing.md` |

## Naming
| Context | Form |
|---|---|
| Display name, page title, docs | `Sphärenmusik` |
| GitHub repository; Vercel and Supabase projects | `sphaerenmusik` |
| `package.json` names | `sphaerenmusik`, `sphaerenmusik-worker` |
| Worker `User-Agent` | `Sphaerenmusik/<version> (<WORKER_CONTACT>)` |

Identifiers, headers, URLs and domains use the ASCII form; HTTP header values must be ASCII.

## Constraints
- Stay on free tiers. Set usage alerts on every service (`doc/deployment.md`).
- Secrets live only in Edge Function secrets, Supabase Vault, Vercel environment variables, `.env.local` and `worker/.env`. No secret is committed or prefixed with `NEXT_PUBLIC_`.
- The worker writes with the Supabase secret key, which Supabase injects into the Edge Function. The browser uses the publishable key and the Clerk session token.
- Realtime carries only changed rows. Per-second data never passes through Realtime.
- Audio safety and visual safety are non-negotiable. The master bus safety stage stays in the signal path. Visual flash limits can only be made stricter.
- The context file is `AGENTS.md`. The repository contains no `CLAUDE.md`. Check with `/context` that `AGENTS.md` is loaded.

## Tech stack
| Layer | Choice |
|---|---|
| Page | Next.js 16 App Router, React 19, Tailwind CSS v4, TypeScript with `allowJs` |
| Auth | Clerk (`@clerk/nextjs`) as a Supabase third-party auth provider |
| Data | Supabase Postgres, row-level security, Realtime, `pg_cron`, `pg_net`, Vault |
| Worker | Supabase Edge Function (Deno) with `@supabase/supabase-js`; its modules use only APIs shared with Node.js 24, so `worker/cli.js` and the `node:test` fixture tests import them |
| Audio | User's engine in `src/audio/` (JavaScript, Web Audio) |
| Visuals | WebGL2, `satellite.js` 6 in a Web Worker |
| Scripts | TypeScript; Sucrase removes types in the sandbox; the TypeScript compiler with `@typescript/vfs` type-checks in an editor-only worker |
| Editor | CodeMirror 6, `@valtown/codemirror-ts` |

`tsconfig.json` lists `worker` and `supabase` in `exclude`. Without those entries `next build` type-checks the worker and the Deno entry point and fails.

## Repository layout
```
app/                         routes and landing components (doc/ui.md)
src/audio/                   user-owned audio engine
src/audio/fx/                user-owned effect kernels, chain and modulation
src/audio-host/              starts the engine and syncs IR instruments to it
src/sky/                     sky store, replay, synthetic triggers, orbit sampling
src/dsl/                     builders, IR schema, validator, migrations, program VM, sandbox runner
src/expr/                    expression interpreter
src/bind/                    binding runtime and program host
src/visual/                  renderer, layer definitions, SGP4 worker, flash guard
src/trace/                   trace bus and JSON Lines export
src/ui/                      editor, console panels, piece session, site header, shared styles
src/lib/                     Supabase clients, settings
src/landing/, src/learn/     landing data and orbits; guide and landing rendering
public/worklets/             engine AudioWorklet processors, including fx-chain.js (user-owned)
public/dsl-sandbox.js        generated sandbox worker for scripts
supabase/functions/harvest/  the worker (Edge Function) and its source registry, sources.json
supabase/migrations/         SQL migrations
supabase/tests/              SQL tests
worker/                      local CLI and fixture tests for the worker, own package.json
scripts/                     generators: worklets, sandbox bundle, builder types, starter IR
tests/                       page-side node:test tests, fakes, fixtures
content/learn/               user guide pages, rendered at /learn (doc/guide.md)
content/starters/            starter projects (.ts) seeded into every account (doc/ui.md, Starter projects)
doc/                         reference docs (doc/README.md)
```

## Division of labor
| Area | Owner |
|---|---|
| Worker, schema, RLS, Realtime, sky store, replay, synthetic triggers | Agent |
| DSL builders, IR schema, validation, migrations, sandbox | Agent |
| Expression interpreter, binding runtime, audio host | Agent |
| Visual renderer, SGP4 worker, flash guard | Agent |
| Console, UI shell, settings, tests, deployment | Agent |
| User guide page (`/learn`, `/try`) and keeping `content/learn/` consistent with the API | Agent |
| Synthesis algorithms and `Instrument` internals in `src/audio/` and `public/worklets/` | User |
| Instrument extensions `setVoicePitch`, `setVoicePan`, `setVoiceMod` | User |
| Effect kernels, `fx-chain` worklet, `EngineFx` (`doc/audio/effects.md`) | User |
| LFOs, modulation routes, `EngineMod`, `ModDef` entries in `PARAM_DEFS` (`doc/audio/modulation.md`) | User |
| Effect and modulation builders, IR fields, validation, data modulation sources | Agent |
| Composition of pieces beyond the starter projects | User |
| Starter projects in `content/starters/`, seeding, build check | Agent |

The agent does not edit files under `src/audio/` or `public/worklets/`, including `src/audio/fx/`. It calls only the interfaces in `doc/bindings.md` and tests against fakes. When a required interface is missing, the agent stops and reports which method is needed.

## Build order
1. **Choose sources.** Confirm the registry in `doc/sources.md`. Call each source twice a few minutes apart, save both responses as fixtures and report what changed.
2. **Give the agent access.** Supabase MCP server scoped to the project; Clerk CLI (`clerk`); Vercel connected to the GitHub repository. Check each one.
3. **Plan the data flow.** Commit `doc/architecture.md` with its chart before any code.
4. **Build the worker.** Apply migrations, run against fixtures, run live locally and watch rows change, then deploy the Edge Function `harvest` and schedule it with `pg_cron` (`doc/worker.md`, Deployment). Add the fixture tests.
5. **Make the page live.** Sign-in, sky store, Realtime subscription, freshness states, subscriptions. Then DSL, bindings, visuals, console and the remaining screens.
6. **Deploy and test.** Deploy to Vercel. Run the manual checklist in `doc/testing.md` with a classmate.

## Rules
- Read the relevant doc before writing or changing code. Change the doc before the behavior it describes.
- Validate all input at boundaries: source responses, IR, settings, Realtime payloads.
- Fail early with a clear message. Successful runs produce no output. Diagnostics go to stderr as JSON lines.
- Keep policy in data: source schedules in `supabase/functions/harvest/sources.json`, DSL defaults, ranges and limits in `src/dsl/limits.js`, synth parameter ranges in `PARAM_DEFS`, effect parameter ranges in the effect registry, layer properties in `src/visual/layer-defs.js`.
- A change to the builder API, a parameter range, a group, a layer property, a problem code or a limit updates `content/learn/` in the same commit (`doc/guide.md`, Consistency).
- A non-200 response from CelesTrak halts that source until a human clears it.
- No agent edits `AGENTS.md` or `README.md` without the user's instruction.

## Documentation
`README.md` introduces the project and how to run it. `doc/README.md` indexes all docs. `doc/audio/` holds the engine reference. `content/learn/` holds the user guide for people writing scripts.
