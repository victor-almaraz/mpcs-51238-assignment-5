# Testing

## Scope
Automated tests run with `node:test`, the SQL tests and the manual deployment checklist. Page-side tests live in `tests/`; worker tests live in `worker/test/`; SQL tests live in `supabase/tests/`.

## Commands
```bash
npm test                 # node --test tests/*.test.js tests/audio/*.test.js
npm run generate:check   # generated files (fx-chain worklet, sandbox bundle, builder.d.ts, starter IR) are current
cd worker && npm test    # node --test test/*.test.js
```
Tests construct no `AudioContext`, no WebGL context and no network connection. They use fakes:

| File | Fakes |
|---|---|
| `tests/fakes.js` | `FakeInstrument`, `FakeEngine`, `FakeAudioParam`, a fake clock, a fake sky store and a trace sink, for the binding runtime and the audio host |
| `tests/fakes/fake-supabase.js` | In-memory Supabase client: REST query builder and Realtime channels, for the sky store |
| `tests/fakes/fake-clock.js` | Manual clock, timers and document visibility, for the sky store |
| `tests/audio/support/webaudio.js` | Web Audio nodes and context, built on `FakeAudioParam`; its `fx-chain` node runs the real `ChainCore` |
| `tests/fixtures/dsl/node-worker.js` | Runs `public/dsl-sandbox.js` in a Node worker thread behind the Web Worker interface |
| `tests/fixtures/dsl/engine-defs.js` | Engine definition tables, so DSL tests do not depend on `src/audio/` |
| `worker/test/fakes.js` | Fake fetch with queued responses per URL, an in-memory store with the semantics of `upsert_sky_objects`, `claim_source` and `claim_host`, a silent logger and a test clock |

## Worker tests
Fixtures in `worker/test/fixtures/` are saved responses: two calls per source, `<source>-1` and `<source>-2`, a few minutes apart (CelesTrak groups 2 h 17 min apart), plus derived fixtures. `captures.jsonl` records the URL, time and status of each capture and the origin of each derived fixture. `worker/test/expected/` holds the expected normalizer output for each fixture.

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

| File | Assertions |
|---|---|
| `normalizers.test.js` | Each normalizer's output for each fixture matches its file in `expected/`; every field is a finite number, string, boolean or `null`; CelesTrak ids are `group:noradId` with six-digit catalog numbers as text; CelesTrak text bodies are rejected; `EPOCH` without a zone is UTC, an offset is kept, an invalid value is rejected; RTSW skips the inactive newest row, records the spacecraft and maps `-9999` and `null` to `null`; trailing NUL bytes are stripped; a CAD version mismatch warns and still normalizes; CAD with `count: 0` is empty; CAD missing a field fails; Scout responses that differ only in `tEphem` normalize identically |
| `pipeline.test.js` | A NUL-padded SWPC body is stored and normalized without its NUL bytes; first run enters every object and an identical second run changes 0 rows; one differing field yields exactly one `update` with its diff; two real SWPC wind captures give one update; a full-group response missing one object yields one `exit`; the raw body is sampled, truncated to 64 KB and never ends in half a surrogate pair; requests carry the ASCII User-Agent; every run inserts exactly one `runs` row; a CelesTrak 403, a CelesTrak 200 with a text body, `[]` or a non-numeric required element halts the group, and no further fetch is made; a CelesTrak 403 halts even when the `runs` insert fails; a CelesTrak run that never records its result halts at the next claim; a CelesTrak claim within the interval is refused without the due check; LL2 429 waits `Retry-After`, or 3600 s without the header, capped at `maxBackoffSec`, and accepts an HTTP date; other failures back off exponentially up to `maxBackoffSec`; a claim taken by an overlapping invocation skips the entry; requests to one host run one at a time, also across overlapping ticks; rows that are not objects and duplicate ids are normalize errors; a normalizer exception is labelled `normalize:` and database errors `store:`; a host lease that cannot be claimed because of a database error counts as failed; `runOnce` takes and releases the host lease, reports a held lease as `host_busy` and refuses a halted entry without fetching; clearing a halt lets the next tick fetch again |
| `scheduler.test.js` | The committed registry is valid and substitutes `LL2_BASE`; an invalid registry fails with a message naming the entry; a 60 s source is due on consecutive one-minute ticks with up to 15 s of jitter; `halted`, `enabled`, backoff and `SOURCES_ENABLED` are respected; CelesTrak is never due before `last_success_at + intervalSec`; canonical JSON sorts keys and the hash ignores key order; the configuration reads `SUPABASE_SECRET_KEYS`, validates `WORKER_CONTACT`, rejects a `SOURCES_ENABLED` pattern that matches no id, and reports malformed `SUPABASE_SECRET_KEYS` as invalid JSON; `parseRetryAfter` reads delta-seconds and HTTP dates |

## SQL tests
`supabase/tests/upsert.sql` runs in the Supabase SQL editor inside `begin; ... rollback;` and raises an exception on the first failed assertion. It checks:
- `upsert_sky_objects` on enter, unchanged, update, exit, a partial response with `p_full` false, and re-enter, including one trace id per row shared by `sky_objects` and `changes`.
- `claim_source`: a stale `p_prev` returns `busy`; a halt-policy claim sets `in_flight_at`; an open run older than 10 minutes halts the source and records a failed run; a halt-policy claim within the interval returns `busy`.
- `claim_host` and `release_host`: same holder, held lease, release and expiry.
- As `anon`: no read on `projects`, no execute on `upsert_sky_objects`, `claim_source` or `claim_host`, and read on `sky_objects`.
- As `service_role`: the worker's direct writes to `source_status`, `source_samples` and `runs` (`database.md`, Worker grants).

`supabase/tests/seed_starters.sql` is described under Starter tests.

## Page tests
Sky data:

| File | Assertions |
|---|---|
| `sky-store.test.js` | `follow` subscribes with the group filter, selects after `SUBSCRIBED`, emits initial enters in id order and buffers events that arrive before the select; `removed_at` produces `exit` and clearing it `enter`; `DELETE` of a held object emits `exit`; duplicates, older rows, other groups and invalid payloads are ignored and invalid ones traced; each change traces `CHANGE` and `REALTIME` records with the row trace id; `follow` replaces the followed set, rejects unknown groups and pages through more than 1,000 rows; the channel closes 60 s after the tab is hidden; `CHANNEL_ERROR` and `TIMED_OUT` call `setAuth` and resubscribe with backoff from 1 s to 30 s; a failing select rejects `follow` and retries |
| `sky-freshness.test.js` | `loading` without a status row; `stale` after 3 × `interval_sec` without success; `down` when halted, when `last_ok` is false or on a channel error; the store polls `source_status` every 30 s and evaluates every 5 s; a failed poll keeps the previous rows; `close` stops polling |
| `sky-groups.test.js` | `src/sky/groups.json` matches the source table and field tables in `sources.md`, the harvest registry and `content/learn/sky-data.md` |
| `sky-replay.test.js` | The starting snapshot is the state at the window start; window events play at the replay speed with their original trace ids; freshness is `fresh` during replay; the window query reads `changes` for the followed groups |
| `sky-synthetic.test.js` | Synthetic enter, update and exit carry `synthetic: true` and `syn-` trace ids; a synthetic freshness state holds until cleared; clearing reloads the database rows |
| `orbit-omm.test.js` | `toOmm` restores the CelesTrak record; `json2satrec(toOmm(fields))` propagates like the raw record; six-digit catalog numbers pass through; missing or invalid elements fail with the field name |
| `orbit-sources.test.js` | For a saved ISS element set and fixed times, the orbit quantities match `satellite.js` reference values; `sunlit` switches within 10 s of a reference; period equals `1440 / meanMotion` minutes within 0.5%; `timeScale` multiplies phase advance; the replay clock drives propagation; propagation failures return the satrec error code |

DSL and sandbox:

| File | Assertions |
|---|---|
| `dsl-builder.test.js` | The examples in `piece-dsl.md` build with no problems; defaults; ids follow creation order; numeric options clamp; choices; expression nodes match the IR schema; modulation, reactions, view and layers; `fn` and `layer.shader` mark the piece local-only; object proxies build the same IR as `field()` and `orbit()`, `o.orbit` exists only on CelesTrak proxies, an unknown property warns `unknown_field`; a builder function runs exactly once per build; problems carry script lines through TypeScript annotations; the script cannot reach network globals or the worker scope |
| `dsl-validate.test.js` | The IR document in `piece-dsl.md` is valid; schema errors carry JSON Pointers; each limit, reference, option, modulation, orbit and context rule produces its problem code |
| `dsl-migrations.test.js` | A step exists for every version below the current one; a stored version-1 IR loads at the current version; a newer version is `ir_version_unsupported`; a missing version is `ir_schema` |
| `dsl-defs.test.js` | Definition tables normalize and survive structured cloning; modulatable flags; invalid tables fail with a message naming the entry |
| `dsl-codes.test.js` | `troubleshooting.md` lists exactly the user-facing codes and `piece-dsl.md` lists every code of `src/dsl/problem-codes.js`; `problem()` rejects unknown codes |
| `expr.test.js` | Each op on numbers, `null` and non-finite input; `map` curves; `octaveInto` range; `quantize` per mode; `rand` determinism; sky sources; dependency collection; colour ops |
| `sandbox.test.js` | `public/dsl-sandbox.js` matches a fresh bundle; type annotations are removed and problem lines match the TypeScript source; a parse error is `syntax_error`; a script that calls `fetch` fails; a script with `while (true) {}` returns `timeout` and the next build works; `fn` evaluation for local-only pieces and its timeouts |
| `types.test.js` | `builder.d.ts` generation is deterministic and the committed files match it; the bundled library files match the installed TypeScript; the example in `piece-dsl.md` and the runnable guide examples yield no diagnostics; each script in `tests/fixtures/dsl/types-invalid/` yields its expected diagnostic; context rules |
| `program-vm.test.js` | Handlers and their groups are recorded in the IR; variables keep their values between calls; `start` calls `enter` handlers once per current object with `initial` true; `every`, sync intervals, `after` and its cancel; seeded `random`, `randInt`, `choose` and `Math.random` repeat; output and `read.*` in setup give `io_outside_handler`; `setTimeout` and `Date` are unavailable; a throwing handler is reported once and disabled; `read` of an unfollowed group throws; at most 256 commands per batch |

Bindings and audio host:

| File | Assertions |
|---|---|
| `bind-voices.test.js` | Voices per object tagged `sky:<binding>:<object>`; top-N selection and reselection; caps; stealing; pitch `null`; `setVoicePan`, `setVoiceMod` and the release-and-restart fallback without `setVoicePitch`; velocity and pitch clamps; Stop releases every voice |
| `bind-triggers.test.js` | Token bucket; `noteOn` and `noteOff` after `durationMs` tagged `trig:<binding>`; a full-group refresh is bounded and excess dropped; `rand` pitch is deterministic; initial enters do not fire triggers |
| `bind-params.test.js` | Smoothed `setParam` at most 30 Hz; requested, sent and applied values traced; `null` keeps the last value; effect follows call `setFxParam` and round enum results |
| `bind-mod.test.js` | Data source id assignment; routes clamp to −1..1 and rates map to −1..1; 30 Hz post limit; orbit sources default to `smoothMs` 500 |
| `bind-reactions.test.js` | Reaction states combine; reactions apply on `stale` and `down` and restore on `fresh` |
| `bind-errors.test.js` | A throwing binding is traced and disabled; a binding to a missing instrument is disabled; failed layer properties are reported once |
| `bind-integration.test.js` | The `piece-dsl.md` example and every starter run through the audio host and the binding runtime |
| `program-host.test.js` | Program commands reach the fake engine with clamped values and `prog:` tags and the event's trace id; at most 200 note starts per second and 256 commands per reply; invalid commands are dropped and traced; a watchdog timeout releases held notes and reports `handler_timeout`; handler errors become `handler_error` problems; the audio host starts, restarts and stops the program, restarts it 1 s after the watchdog stops it, and gives up after 3 restarts a minute |
| `sandbox-program.test.js` | With a fake worker: after a reset, a `start` rebuilds the last good build in the new worker first; a `start` has the build's time limit and a `batch` the 250 ms one; a batch without a worker or a good build reports a lost VM |
| `audio-host.test.js` | `irToWidgets`; Run order (master bus, engine, sync, tempo, effects, LFOs, routes); `pump` every 25 ms; `fxFault` and safety notices; hot reload posts only changed parts; Stop and `dispose` |
| `audio-host-master.test.js` | Master fade-in after the engine starts and after every resume, none while muted; a seed change disposes the old engine 50 ms after its fade; layer audio signals read the engine taps; `FakeEngine` mirrors the real engine |
| `trace-replay.test.js` | See Trace-replay tests |

Visuals:

| File | Assertions |
|---|---|
| `flash-guard.test.js` | A 5 Hz full-frame flash is limited and traced; a 2 Hz flash and a small-area flash pass; saturated red flashes are limited; the limit only gets stricter; the full loop never shows more than 3 flashes in 1 s; a non-finite limit throws |
| `visual-layer-defs.test.js` | `LAYER_DEFS` matches the property tables in `visuals.md` and `content/learn/reference.md`; reduced motion forces `trail`, `fade` and `drift` to 0 |
| `visual-layer-state.test.js` | Property coercion, layer diffs, the property resolver, reduced motion and the 1 Hz value gate |
| `visual-positions.test.js` | Interpolation; the sample buffer; the propagator batches events, starts the worker lazily and traces worker errors |
| `visual-propagation.test.js` | Positions match `satellite.js` for every station; failed objects are omitted and traced once; phase period, `timeScale`, replay clock, orbit sources and path sampling |
| `visual-projection.test.js` | `map`, `sky` and `orbital` projections; occlusion; camera turn and its stop under reduced motion; launch pads on the surface |
| `visual-scene.test.js` | Sprite positions and properties, occluded opacity, glyph fades, trail segments at the antimeridian, path requests |
| `visual-renderer.test.js` | Shared defaults; error throttling; a non-finite flash limit is rejected; highlight lookup; `dispose` deletes the GL objects |
| `visual-misc.test.js` | Audio clock, reduced-motion setting, pixel ratio, colour helpers, guard readback, the 2D summary without WebGL2 |

Trace bus and UI:

| File | Assertions |
|---|---|
| `trace-bus.test.js` | Record stamping and validation; the ring buffer drops the oldest record; 2,000 records by default, 500–5000 from settings; chains by trace id; JSON Lines export round trip; `safeTrace` never throws |
| `settings.test.js` | Defaults round-trip; unknown keys are dropped; looser safety values are rejected and stricter ones accepted; `masterDb` is clamped to `maxMasterDb`; the OS reduced-motion preference cannot be overridden |
| `ui-settings-view.test.js` | Every setting has one entry; search; safety values can only be made stricter; `settings.json` round trip |
| `ui-layout.test.js` | Every layout part is shown by default; the layout round-trips through `localStorage`; malformed stored layouts fall back field by field; the layout shortcuts of `ui.md` |
| `ui-shortcuts.test.js` | Shortcut parsing and matching; `Mod` is `Cmd` on macOS; Escape twice within 500 ms is Panic in the editor |
| `ui-palette.test.js` | The palette lists the commands of `ui.md`; fuzzy matching and ranking; commands that need a piece, a project or an account are hidden without one |
| `ui-master.test.js` | Master level and clamps; Panic ramps to 0 over 10 ms and Reset needs one click after 1 s; the meter; Panic falls back to `releaseAll` |
| `ui-piece-session.test.js` | Load, Run, reload, Panic and Reset with a fake engine; actions during a starting Run; replay needs the database |
| `ui-autosave.test.js` | Save 2 s after the last edit; flush; offline hold; retry with backoff |
| `ui-projects.test.js` | Starter manifest; seeding while `starters_version` is below the manifest version; unique bounded names; project rows |
| `ui-subscriptions.test.js` | Subscription diffs write only the difference; `createProject` deletes the new row when its subscriptions cannot be written |
| `ui-console.test.js` | Console filters, diffs, badges, source rows, REST row validation, merging live and history records, the announcer |
| `ui-status.test.js` | Freshness items, time formatting, status sources, audio and save labels |
| `ui-sky-switch.test.js` | Switching between the live and replay stores exits held objects, then follows the same groups on the new store; the null sky follows without objects |
| `ui-completion.test.js` | Editor completion of builder names, group keys, fields, orbit quantities and option names |
| `ui-ir-helpers.test.js` | Orbit sources, layer values, backgrounds; the page re-validates IR from the worker |
| `ui-local-fn.test.js` | Local `fn` results: first read `null`, later the result; invalid results become `null` |
| `palette.test.js` | Theme text tokens and editor status hues reach 4.5:1 contrast; neutrals are black and white only |

## Engine tests (user-owned)
`tests/audio/` holds the engine's tests, run by `npm test`:

| File | Assertions |
|---|---|
| `effects.test.js` | Effect kernels: registry, per-kernel response, clamps, bounded output, delay loop gain below 1, reverb decay, compressor curve, EQ, filter, saturation ADAA and distortion; `EffectSlot` 10 ms bypass crossfade and fault on non-finite state; denormal flush; CPU |
| `fx-chain.test.js` | `ChainCore` slot changes and fades, fault reporting, invalid messages, 32-frame route evaluation, data smoothing, LFO phase and tempo re-anchoring; the committed `public/worklets/fx-chain.js` is up to date and registers `fx-chain` |
| `modulation.test.js` | Normalized sum and clamp on `lin`, `log` and `pow3`; `down` parameters never exceed base; enum and array targets rejected; audio-rate depth conversion and gain limit; LFO shapes; seeded `random` and `smooth` |
| `engine-fx-mod.test.js` | Chain placement before `mixBus` and `masterGain`; removal restores direct wiring; `FxLimitError`, `ModLimitError` and `ModTargetError` at each limit; routes, LFOs and data values reach chains and voices; voice control by source tag; analysis taps |
| `param-defs.test.js` | `coerceParam`, `coerceVolume`, `dbToGain`, `mtof`, `velocityGain` and defaults |
| `scaling.test.js` | `fromNorm` and `toNorm` on `lin`, `log` and `pow3`, round trips for every numeric def |
| `envelope.test.js` | Envelope values and scheduling for attack, decay, sustain and release, with and without `cancelAndHoldAtTime` |
| `smoothing.test.js` | `TrackedParam` time constants and segments |
| `voices.test.js` | Voice caps and stealing order |
| `sample.test.js` | Sample normalization, DC removal, edge fades, mono mix and rejection of silent files |

Kernel and model tests run in Node without Web Audio. Engine graph and audio-rate route tests use the fake nodes in `tests/audio/support/webaudio.js`.

## Guide tests
Guide consistency (`guide.md`, Consistency) is checked by these tests:
1. `guide.test.js`: every page in `content/learn/` has a `title` and a unique `order`, and every internal link resolves to a page or a heading anchor.
2. `guide.test.js`: every runnable example builds through Sucrase, the builder and the validator with zero problems against the real definition tables. `types.test.js`: every runnable example type-checks against `builder.d.ts` with zero diagnostics.
3. `guide.test.js`: the instrument tables in `reference.md` match `PARAM_DEFS`, and the effect table matches the effect registry: names, ranges, defaults and choice options.
4. `visual-layer-defs.test.js`: the layer property table in `reference.md` matches `src/visual/layer-defs.js`.
5. `guide.test.js` and `sky-groups.test.js`: the groups and fields in `sky-data.md` match `src/sky/groups.json`.
6. `dsl-codes.test.js`: the codes in `troubleshooting.md` match the user-facing codes in `src/dsl/problem-codes.js`.
7. `guide.test.js`: the limits in `reference.md` match the validator and engine constants.

Table checks parse the Markdown tables; they compare values, not formatting.

## Landing tests
`tests/landing.test.js` reads `content/landing.md` and asserts:
1. Front matter has `title` and `description`, and the page has one `h1` and the section headings listed in `ui.md`, Landing.
2. The script in "How it works" equals the first runnable example of `first-piece.md`, so it builds and type-checks under the guide tests, and its highlighted code keeps its text.
3. The ISS figures (93 minutes, twenty octaves, about 188 Hz) agree with the ISS element set in `worker/test/expected/celestrak-stations-1.json` within 1 minute and 1 Hz.
4. The live strip summarizes values, the next future launch and freshness, and drops and traces invalid rows.
5. The orbit map's ground track stays within the ISS inclination, the subsolar latitude is correct at the solstice, the terminator puts the Sun on the horizon, and objects with invalid elements are omitted.

## Starter tests
| Area | Assertions |
|---|---|
| Build (`tests/starters.test.js`) | The manifest lists starters with unique slugs and names; each starter builds with zero errors, zero warnings and zero type diagnostics, opens with comments naming its guide pages, and its `.ir.json` matches the compiled IR |
| Runtime (`tests/bind-integration.test.js`) | Each starter runs through the audio host and the binding runtime |
| Seeding (`supabase/tests/seed_starters.sql`) | First call inserts every starter with its subscriptions and sets `starters_version`; a second call inserts nothing; a deleted starter is not recreated at the same version; a higher version adds only missing slugs; duplicate groups, a missing source and non-array groups seed; a `null` `p_projects` raises and keeps the version; one user cannot insert projects or subscriptions for another user |

## Trace-replay tests
`tests/trace-replay.test.js` reads each console export (`.jsonl`) in `tests/fixtures/traces/`, feeds its `CHANGE` records through the binding runtime with fake instruments, and compares the produced `AUDIO` records with those in the file. To add a fixture, export a trace from a session that behaved as intended and commit it under `tests/fixtures/traces/` with the running IR as `<name>.ir.json`. The replay stops the runtime at the end only when the export contains Stop's noteOffs (`traceId` null), so exports taken while the piece plays and after Stop both compare. A second test checks the harness itself: an export produced with fakes replays to the same `AUDIO` records.

| Fixture | Session |
|---|---|
| `first-piece-synthetic` | `/try` with the first example of `first-piece.md` in headless Chrome: three `celestrak.stations` objects entered through the synthetic panel, one update raising `meanMotion` 1.5× (pitch +7 semitones), one exit; exported while playing |

## Manual checklist
1. The `harvest` function logs show no errors for 10 minutes, and `runs` gains rows for each source on schedule.
2. In a private window, `/listen` updates without a refresh, and `/console` shows changes arriving.
3. In `/listen`, a single `Escape` while sound plays is Panic: sound stops at once.
4. A classmate signs in for the first time and sees the three starter projects in the Projects list (`Example: Station chord`, `Example: Solar wind`, `Example: Scout bells`). The classmate opens `Example: Station chord`, presses Run, hears sound and sees the preview update.
5. In the editor, the three toggle buttons, `Mod-B`, `Mod-Alt-B` and `Mod-J` hide and show the side panel, the preview and the bottom panel; the transport strip stays visible. After a reload the layout is restored. `Escape` twice within 500 ms is Panic.
6. In `/projects/[id]/run`, `C`, `N` and `S` toggle the console, voices and status overlays, a single `Escape` is Panic, and `E` returns to the editor.
7. In `/try`, an example from the Programs guide page (`/learn/programs`) plays notes from its handlers. In a saved project with handlers, each save restarts the program, and a handler error appears in Problems as `handler_error`.
8. The classmate's projects are invisible to another account. Check through the UI and in the SQL editor:
   ```sql
   begin;
   set local role authenticated;
   set local request.jwt.claims = '{"sub":"<other user id>","role":"authenticated"}';
   select count(*) from public.projects;   -- 0 rows of the classmate
   rollback;
   ```
9. Stop the worker with `select cron.unschedule('harvest');`. After three intervals the status bar shows stale for SWPC. Reschedule it with the `cron.schedule('harvest', ...)` statement (`database.md`, Harvest schedule). Point one registry URL at a 404 and redeploy the function; the source shows down.
10. In the SQL editor, confirm that `sky_objects` is in `supabase_realtime`, that `anon` and `authenticated` hold `select`, and that the read policy exists.
11. With `prefers-reduced-motion` on, trails, ring pulses, glyph fades, aurora drift and camera motion are off.

## Sources
- Node.js, Test runner: https://nodejs.org/api/test.html
- Supabase docs, Testing your database: https://supabase.com/docs/guides/database/testing
