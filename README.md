# Sphärenmusik

Sphärenmusik is a generative audio-visual web piece driven by live space data. Satellite orbits, the solar wind, asteroids passing Earth and rocket launches arrive in the browser as they change, and a short TypeScript script decides how each change sounds and looks. A console shows every raw event behind the output.

The name is German for "music of the spheres". The piece draws on that idea and on the pairing of music and astronomy in the medieval quadrivium.

## How it works
1. A Supabase Edge Function, `harvest`, runs every minute from a `pg_cron` job. It fetches each due source, normalizes the response, and writes only the rows whose content changed, recording one `runs` row per fetch.
2. Supabase Realtime sends each changed row to the open pages.
3. In the editor, a piece script runs in a sandboxed Web Worker. It returns a JSON intermediate representation (IR) that binds sky data to instruments and visual layers, and it may register handlers that react to events and timers.
4. The page validates the IR, plays it through a Web Audio engine with a safety limiter on the master output, and draws it with WebGL2.

`doc/architecture.md` has the data-flow chart and the path of one change from a source to the speakers.

## Data sources
| Source | Data | Refresh |
|---|---|---|
| CelesTrak GP | Orbital elements of space stations, GPS satellites, bright satellites and debris | About every 2 hours |
| NOAA SWPC | Planetary Kp index, solar wind speed, density, temperature and magnetic field | Every minute |
| NASA JPL CAD and Scout | Close approaches and newly observed near-Earth object candidates | 15 minutes to 6 hours |
| Launch Library 2 | Upcoming rocket launches | Every 10 minutes |

None of the sources requires an API key. `doc/sources.md` lists each endpoint, its fields and its failure policy.

## Features
- **Listen** (`/listen`): a starter piece in full-window run mode, without an account.
- **Editor** (`/projects/[id]`, `/try`): CodeMirror with type-aware completion, hover types and inline problems; a live preview; a bottom panel with the console, problems, the compiled IR and the trace. The side panel, preview and bottom panel can each be hidden (`Mod-B`, `Mod-Alt-B`, `Mod-J`).
- **Guide** (`/learn`): the user guide for the piece script, with runnable examples that open in the editor.
- **Console** (`/console`): sources, runs, events and trace records of every group, with trace export as JSON Lines. Replay of past data runs from the editor's bottom panel.
- **Projects and settings** (`/projects`, `/settings`): per-user projects and settings under row-level security. Each account starts with three starter projects.

## Safety
- A safety stage on the master output limits peaks, removes DC offset and lowers sustained loud output. No script setting bypasses it.
- Panic stops all sound and mutes the master: the Panic button, `Escape` twice in the editor, and `Escape` in run mode.
- Sound starts only after a click and a start notice that warns about volume and photosensitivity.
- The visual flash guard limits luminance flashes to the configured rate, at most three per second; settings can only make it stricter.

## Repository layout
| Path | Contents |
|---|---|
| `app/` | Next.js App Router routes |
| `src/` | Page code: sky store, DSL, expression interpreter, binding runtime, audio engine and host, visuals, trace bus, UI |
| `public/` | AudioWorklet processors and the generated DSL sandbox bundle |
| `content/learn/`, `content/starters/` | User guide pages and starter projects |
| `supabase/functions/harvest/` | The worker (Edge Function) |
| `supabase/migrations/`, `supabase/tests/` | Database schema, functions, access rules, cron jobs and SQL tests |
| `worker/` | Local command-line runner and fixture tests for the worker |
| `scripts/` | Generators for worklets, the sandbox bundle, builder types and starter IR |
| `tests/` | Page tests (`node:test`), fakes and fixtures |
| `doc/` | Reference documentation; `doc/README.md` is the index |

## Requirements
- Node.js 24 or later.
- A Supabase project with the `pg_cron` and `pg_net` extensions.
- A Clerk application with the Supabase integration enabled.
- A Vercel account for hosting the page.

## Local development
1. Install dependencies:
   ```bash
   npm install
   ```
2. Create `.env.local` with `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` (`doc/deployment.md`).
3. Start the development server:
   ```bash
   npm run dev
   ```
4. Open `http://localhost:3000`.

`npm run build` regenerates the worklets, the sandbox bundle, the builder types and the starter IR (`npm run generate`) before `next build`.

## Tests
```bash
npm test                      # page tests
npm run generate:check        # generated files are current
npx tsc --noEmit              # type check
cd worker && npm test         # worker fixture tests
```

The SQL tests in `supabase/tests/` run in the Supabase SQL editor; each runs inside a transaction that rolls back. `doc/testing.md` lists the automated tests and the manual checklist.

## Worker
The worker is the Supabase Edge Function `harvest`, invoked every minute by the `pg_cron` job `harvest` through `pg_net`. The function checks a bearer token (`HARVEST_TOKEN`), so JWT verification is off. Its secrets are `HARVEST_TOKEN`, `WORKER_CONTACT` and `LL2_BASE`; Supabase injects the project URL and secret key.

To run sources locally against the same project, copy `worker/.env.example` to `worker/.env`, fill it in, and run from `worker/`:
```bash
node --env-file=.env cli.js tick
node --env-file=.env cli.js --once swpc.wind
```

A CelesTrak source that returns a non-200 status halts until a person clears it (`cli.js clear-halt <id>`). `doc/worker.md` covers deployment, scheduling, failure policies and logs.

## Deployment
| Service | Hosts | Plan |
|---|---|---|
| Vercel | The Next.js page | Hobby |
| Supabase | Postgres, Realtime, `pg_cron`, `pg_net`, the `harvest` Edge Function | Free |
| Clerk | Sign-in | Free |

`doc/deployment.md` lists every environment variable, the setup steps for each service, and the free-tier limits.

## Documentation
- `doc/README.md`: index and reading order of the reference docs.
- `content/learn/`: the user guide, served at `/learn`.
- `AGENTS.md`: rules and division of labour for coding agents working in this repository.

## Data attribution
Orbital data: CelesTrak. Space weather: NOAA Space Weather Prediction Center. Close approaches and Scout: NASA/JPL Center for Near Earth Object Studies. Launches: The Space Devs, Launch Library 2.

This project was built for MPCS 51238 *Design, Build, Ship* at the University of Chicago.
