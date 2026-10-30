# Worker

## Scope
The harvest worker: a Supabase Edge Function that `pg_cron` invokes once a minute. Covers the invocation model, pipeline, failure policies, environment, logs, local runs, deployment and tests.

## Job
On each invocation, fetch every due source, normalize the response, write only changed objects, and record the run.

## Interface
- **Input:** `sources.json` (bundled with the function), function secrets, `source_status` rows, one `POST` from `pg_cron` per minute.
- **Output:** rows in `sky_objects`, `changes`, `runs`, `source_status`, `source_samples`.
- **Errors:**
  - Request without the correct `Authorization: Bearer <HARVEST_TOKEN>` header: HTTP 401, nothing runs.
  - Invalid registry or missing secret: HTTP 500 with a message naming the problem; nothing runs.
  - Fetch or normalize error: that run fails; the other due sources still run.
  - Unhandled exception: the invocation ends; the next minute's invocation resumes from `source_status`.

## Layout
```
supabase/functions/harvest/   deployed Edge Function (Deno)
  index.ts                    Deno.serve entry: auth check, secrets, client, background tick
  sources.json                source registry (sources.md)
  config.js                   read secrets and environment, build the User-Agent
  registry.js                 load and validate the registry
  scheduler.js                due computation, per-host grouping, failure policies
  fetch.js                    HTTP GET with User-Agent and timeout
  normalizers/                one module per normalizer name, index.js maps names
  hash.js                     canonicalJson, sha256
  pipeline.js                 one tick: claim, fetch, normalize, upsert, record
  store.js                    Supabase RPC and table writes
  log.js                      JSON-lines logger on stderr
worker/                       Node.js package for tests and local runs (not deployed)
  package.json                "name": "sphaerenmusik-worker", "type": "module", "engines": { "node": ">=24" }
  cli.js                      local commands: tick, --once <id>, clear-halt <id>
  test/
    fixtures/                 saved source responses, captures.jsonl
    fakes.js                  fake fetch, fake store
    *.test.js                 node:test tests
```
Modules other than `index.ts` use only APIs that Node.js 24 and Deno share (`fetch`, `AbortSignal.timeout`, `crypto.subtle`, `TextEncoder`), import only relative paths, and receive their dependencies as arguments. `worker/` tests and `worker/cli.js` import them from `../supabase/functions/harvest/`.

## Invocation model
- `pg_cron` job `harvest` runs every minute and calls `net.http_post` on `/functions/v1/harvest` with `Authorization: Bearer <HARVEST_TOKEN>`, read from Vault (`database.md`, Harvest schedule).
- The function checks the token, answers HTTP 202 at once, and runs the tick in `EdgeRuntime.waitUntil`. `pg_net`'s request timeout therefore never cuts a tick short.
- A tick loads `source_status`, selects due entries, and claims each one by a conditional update of `last_attempt_at` (compare-and-set on its previous value). An entry that another overlapping invocation claimed first is skipped.
- A registry entry is due when it is enabled, listed in `SOURCES_ENABLED` (when set), not halted, `now ≥ next_attempt_at` (when set), and `now − last_attempt_at ≥ intervalSec − 15 s`. The 15 s slack absorbs cron jitter so that 60 s sources run every minute. Entries with policy `halt` (CelesTrak) also require `now − last_success_at ≥ intervalSec`, without slack.
- Due entries on the same host run one after another; different hosts run in parallel.
- A tick ends within 120 s. A request still open at that point is aborted and recorded as a timeout.
- Edge Function limits: 2 s CPU per invocation (I/O wait excluded), 150 s wall clock on the Free plan, 256 MB memory.

## Pipeline
1. `fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) })`.
2. On a non-200 status, apply the entry's failure policy and record a failed run.
3. Upsert the raw body, truncated to 64 KB, into `source_samples`.
4. Normalize the body to `SkyObject[]`. Compute `hash` for each object.
5. Call RPC `upsert_sky_objects(p_source, p_group, p_rows, p_full)`. The RPC writes only rows whose hash differs, marks absent objects removed when `p_full` is true, inserts one `changes` row per changed object, and returns the changed ids.
6. Insert one `runs` row and upsert `source_status`.

The conditional write runs in SQL because `supabase-js` `.upsert()` cannot express `ON CONFLICT ... DO UPDATE ... WHERE`.

## Failure policies
| Policy | Behavior |
|---|---|
| `halt` | Set `halted = true`, log `error` with event `halt`. No retry until a human clears the halt. |
| `retryAfter` | Set `next_attempt_at` to now plus the `Retry-After` header value in seconds, or 3600 s when absent. |
| `backoff` | Set `next_attempt_at` to now plus `min(intervalSec × 2^failures, maxBackoffSec)`. `failures` resets to 0 on success. |

A timeout or network error counts as a non-200 status. A normalize error under policy `halt` also halts.

Clear a halt in the Supabase SQL editor:
```sql
update public.source_status set halted = false, failures = 0, next_attempt_at = null
where source_id = 'celestrak.stations';
```
or locally with `node --env-file=.env cli.js clear-halt celestrak.stations`.

## Secrets and environment
Edge Function secrets (Dashboard → Edge Functions → Secrets):

| Name | Example | Required |
|---|---|---|
| `HARVEST_TOKEN` | 32 random bytes, hex | yes; same value as Vault secret `harvest_token` |
| `WORKER_CONTACT` | `name@uchicago.edu` | yes |
| `LL2_BASE` | `https://ll.thespacedevs.com/2.3.0` | yes |
| `SOURCES_ENABLED` | `swpc.*,celestrak.stations` | no; default enables every entry with `enabled: true` |
| `LOG_LEVEL` | `warn` | no; default `warn` |

Supabase injects `SUPABASE_URL` and `SUPABASE_SECRET_KEYS` (a JSON object; the function uses its `default` entry). Names starting with `SUPABASE_` are reserved and cannot be set as custom secrets.

Local runs read `worker/.env`, listed in `.gitignore`, with the same names plus `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (`sb_secret_...`). `worker/.env.example` lists every name with no values.

The secret key bypasses row-level security. It exists only in the function's injected environment and in `worker/.env`.

## Logs
The function writes one JSON object per line to stderr (`console.error`). At the default level `warn`, a successful run writes nothing.
```json
{"t":"2026-10-29T14:00:00.123Z","level":"error","source":"celestrak.stations","event":"halt","status":403}
{"t":"2026-10-29T14:01:00.004Z","level":"warn","source":"jpl.cad","event":"version_mismatch","got":"1.6"}
{"t":"2026-10-29T14:02:00.010Z","level":"info","source":"swpc.wind","event":"run","ok":true,"rowsChanged":1,"ms":412}
```
Read production logs in Dashboard → Edge Functions → `harvest` → Logs. The `cron.job_run_details` table shows each cron invocation, and `net._http_response` shows each HTTP 202.

## Local run
```bash
cd worker
npm ci
cp .env.example .env                       # fill in the variables
node --env-file=.env cli.js --once swpc.wind
node --env-file=.env cli.js tick           # one tick over all due sources
npm test                                   # node --test
```
`--once <id>` ignores the due check but honors `halted`. Local runs write to the same project as the deployed function; a CelesTrak group fetched locally cannot be fetched again from the deployed function before the next GP update.

## Deployment
1. Dashboard → Edge Functions → Deploy a new function → name `harvest`. Create one file per module in `supabase/functions/harvest/` with the same relative paths, and paste each file's contents.
2. In the function's settings, turn off "Verify JWT". The function checks `HARVEST_TOKEN` itself.
3. Set the secrets in the table above.
4. In the SQL editor, store the Vault secrets and create the cron job (`database.md`, Harvest schedule).
5. Confirm: `select * from public.runs order by started_at desc limit 20;` gains rows each minute for SWPC.

To stop the worker: `select cron.unschedule('harvest');`. To start it again, rerun the `cron.schedule` statement.

## Sources
- Supabase docs, Scheduling Edge Functions: https://supabase.com/docs/guides/functions/schedule-functions
- Supabase docs, Edge Function limits: https://supabase.com/docs/guides/functions/limits
- Supabase docs, Edge Function secrets: https://supabase.com/docs/guides/functions/secrets
- Supabase docs, Background tasks: https://supabase.com/docs/guides/functions/background-tasks
- Supabase docs, Static egress IPs: https://supabase.com/docs/guides/troubleshooting/why-supabase-edge-functions-cannot-provide-static-egress-ips-for-whitelisting-3d78b0
- CelesTrak, Usage Policy: https://celestrak.org/usage-policy.php
- JPL SSD/CNEOS API service: https://ssd-api.jpl.nasa.gov/
