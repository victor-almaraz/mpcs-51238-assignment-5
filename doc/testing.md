# Testing

## Scope
Automated tests run with `node:test` and the manual deployment checklist. Page-side tests live in `tests/`; worker tests live in `worker/test/`; SQL tests live in `supabase/tests/`.

## Commands
```bash
npm test                 # node --test tests/*.test.js tests/audio/*.test.js
npm run generate:check   # generated files (fx-chain worklet, sandbox bundle, builder.d.ts, starter IR) are current
cd worker && npm test    # node --test test/*.test.js
```
Tests construct no `AudioContext`, no WebGL context and no network connection. They use fakes.

## Worker fixture tests
Fixtures in `worker/test/fixtures/` are saved responses: two calls per source, a few minutes apart (one call per CelesTrak group, whose GP data changes once every 2 hours), plus derived fixtures. `captures.jsonl` records the URL, time and status of each capture and the origin of each derived fixture.


| Fixture | Purpose |
|---|---|
| `celestrak-403.txt` | One-download-per-update response |
| `celestrak-no-data.txt` | HTTP 200 with a text body |
| `swpc-wind-nul.json` | Trailing NUL bytes |
| `swpc-wind-9999.json` | `-9999` sentinels |
| `swpc-wind-inactive-first.json` | Newest row not `active` |
| `jpl-cad-empty.json` | `count: 0` |
| `jpl-cad-version.json` | Unexpected `signature.version` |
| `ll2-429.json` | Rate-limit response with `Retry-After` |

The tests run the pipeline with a fake fetch and a fake store that implements `upsert_sky_objects` in memory, and assert:
1. Each normalizer's output matches its expected JSON file.
2. A second run with an identical response changes 0 rows.
3. A run whose response differs in one field yields exactly one `update` with the correct diff.
4. A full-group response missing one object yields one `exit`.
5. Every run inserts exactly one `runs` row with the right `ok` and `rows_changed`.
6. A CelesTrak 403 sets `halted`, and no further fetch is scheduled.
7. LL2 429 waits `Retry-After`; other failures back off exponentially up to `maxBackoffSec`.
8. An invalid registry fails the invocation with a message naming the entry.
9. A claim already taken by an overlapping invocation skips the entry.
10. The due check runs a 60 s source on consecutive one-minute ticks with up to 15 s of jitter.

## SQL tests
`supabase/tests/upsert.sql` runs in the Supabase SQL editor inside `begin; ... rollback;`, raises an exception on the first failed assertion, and checks the RPC on enter, unchanged, update, exit and re-enter, and checks that `anon` cannot read `projects` or execute the RPC.

## Page tests
| Area | Assertions |
|---|---|
| Expression interpreter | Each op on numbers, `null` and non-finite input; `octaveInto` range; `quantize` per mode; `rand` determinism |
| IR validator | Valid example passes; each limit and reference rule produces its error code and JSON Pointer |
| Migrations | Each step on a fixture; round trip to the current version |
| Sandbox | A script with `while (true) {}` returns `timeout`; a script that calls `fetch` fails; type annotations are removed and problem lines match the TypeScript source |
| Types | `builder.d.ts` generation is deterministic; a fixture of invalid scripts (unknown option, unknown group, unknown field on a proxy, `mod` on an enum, `orbit` outside a current-object context) each yields the expected diagnostic; the example in `piece-dsl.md` yields none |
| Object proxies | `o.<field>` builds the same IR as `field('<field>')`; `o.orbit(q)` the same as `orbit(q)`; a builder function runs exactly once per build |
| Bindings (fakes) | Top-N selection and reselection; caps; enter/exit note pairing by source tag; pitch glide and fallback; trigger rate limit drops; param smoothing and 30 Hz updates; freshness reactions apply and restore |
| Sky store | Buffering during `follow`; `removed_at` produces `exit`; freshness rules at each threshold |
| Flash guard | A synthetic 5 Hz full-frame flash is limited; a 2 Hz flash passes; a small-area flash passes |
| Settings | Unknown keys dropped; looser safety values rejected |
| Orbit sources | For a saved ISS element set and fixed times: `latitude`, `phaseSin`/`phaseCos`, `altitude` and `elevation` match `satellite.js` reference values; `sunlit` switches at shadow entry and exit within 10 s of a reference; period equals `1440 / meanMotion` minutes within 0.5%; `timeScale` multiplies phase advance; replay clock drives propagation |
| IR: effects and modulation | Slot, reverb, LFO, route and per-target limits; unknown and non-modulatable targets; `lfo_rate_range`; slot in two chains |
| Bindings: effects and modulation | Host calls `setTempo`, `setFx` and `setMods` in order; data source id assignment; route clamp to −1..1; rate mapping to −1..1; 30 Hz post limit; `fxFault` trace and notice |

## Engine tests (user-owned)
`tests/audio/` holds the engine's tests, run by `npm test`:

| Area | Assertions |
|---|---|
| Effect kernels | Assignment 3's `effects.test.js`, ported: per-kernel response, clamps, feedback below 1, ADAA output bounds |
| `EffectSlot` | 10 ms bypass crossfade; fault on energy above `1e12` resets and bypasses once; non-finite input is silenced without a fault |
| Modulation model | Normalized sum and clamp on `lin`, `log` and `pow3` defs; `down` parameters never exceed base; enum and array targets rejected |
| LFOs | Phase from frames equals phase from `t − t₀`; `random` and `smooth` sequences repeat for a seed; rate changes keep phase continuous |
| Audio-rate routes | Depth-to-gain conversion (cents for log, units for lin); route gain limit keeps `toNorm(base) ± Σ |depth|` within 0–1 |
| Limits | `FxLimitError` and `ModLimitError` at each documented limit |
| Chain processor | `ChainCore` message handling, invalid messages, 32-frame route evaluation, reports, data smoothing, tempo re-anchoring; the committed `public/worklets/fx-chain.js` is up to date and registers `fx-chain` |
| Engine graph | Chain placement before `mixBus` and `masterGain`, removal and `dispose` restore direct wiring, route distribution to chains and instruments, voice control by source tag, analysis taps |

Kernel and model tests run in Node without Web Audio. Engine graph and audio-rate route tests use the fake nodes in `tests/audio/support/webaudio.js`, built on the fake `AudioParam` in `tests/fakes.js`; its `fx-chain` node runs the real `ChainCore`.

## Guide tests
`tests/guide.test.js` reads `content/learn/*.md` and asserts:
1. Every page has front matter with `title` and a unique `order`, and every internal link resolves to a slug or heading anchor.
2. Every `ts piece` code block builds through Sucrase, the builder and the validator with zero errors, and type-checks against `builder.d.ts` with zero diagnostics.
3. The parameter tables in `reference.md` match `PARAM_DEFS` and the effect registry: names, ranges, defaults and choice options.
4. The layer property table matches `src/visual/layer-defs.js`.
5. The groups and fields in `sky-data.md` match `src/sky/groups.json`.
6. The codes in `troubleshooting.md` match the user-facing codes in `src/dsl/problem-codes.js`.
7. The limits in `reference.md` match the validator constants.

Table checks parse the Markdown tables; they compare values, not formatting.

## Landing tests
`tests/landing.test.js` reads `content/landing.md` and asserts:
1. Front matter has `title` and `description`, and the page has one `h1` and the section headings listed in `ui.md`, Landing.
2. The script in "How it works" equals the first runnable example of `first-piece.md`, so it builds and type-checks under the guide tests.
3. The ISS figures (93 minutes, twenty octaves, about 188 Hz) agree with the ISS element set in `worker/test/fixtures/celestrak-stations-1.json` within 1 minute and 1 Hz.

## Starter tests
| Area | Assertions |
|---|---|
| Build | Every manifest slug has a `.ts` file; each builds with zero errors and zero warnings, type-checks with zero diagnostics, and `.ir.json` matches the compiled IR |
| Seeding (`supabase/tests/seed_starters.sql`) | First call inserts every starter with its subscriptions and sets `starters_version`; a second call inserts nothing; a deleted starter is not recreated at the same version; a higher version adds only missing slugs; one user's call cannot insert rows for another user |

## Trace-replay tests
`tests/trace-replay.test.js` reads a console export (`.jsonl`), feeds its `CHANGE` records through the binding runtime with fake instruments, and compares the produced `AUDIO` records with those in the file. Export a trace from a session that behaved as intended and commit it under `tests/fixtures/traces/`.

## Manual checklist
1. The `harvest` function logs show no errors for 10 minutes, and `runs` gains rows for each source on schedule.
2. In a private window, `/listen` updates without a refresh, and `/console` shows changes arriving.
3. A classmate signs in for the first time, sees the starter projects in the Projects list, opens `Example: Station chord`, presses Run, hears sound and sees the preview update.
4. The classmate's projects are invisible to another account (check through the UI and through `select` in the SQL editor after `set local role authenticated; set local request.jwt.claims = '{"sub":"<other user id>"}';`).
5. Stop the worker with `select cron.unschedule('harvest');`. After three intervals the status bar shows stale for SWPC. Reschedule it, point one registry URL at a 404 and redeploy the function; the source shows down.
6. In the SQL editor, confirm that `sky_objects` is in `supabase_realtime`, that `anon` and `authenticated` hold `select`, and that the read policy exists.
7. With `prefers-reduced-motion` on, trails and pulses are off.

## Sources
- Node.js, Test runner: https://nodejs.org/api/test.html
- Supabase docs, Testing your database: https://supabase.com/docs/guides/database/testing
