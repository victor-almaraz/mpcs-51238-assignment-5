# Worker

## Scope
The long-running Node.js process on Railway: process model, pipeline, failure policies, environment, logs, local runs, deployment and tests.

## Job
Fetch each due source, normalize the response, write only changed objects, and record the run.

## Interface
- **Input:** `worker/sources.json`, environment variables, `source_status` rows.
- **Output:** rows in `sky_objects`, `changes`, `runs`, `source_status`, `source_samples`.
- **Errors:**
  - Invalid registry or missing environment variable: exit 1 at boot with a message naming the problem.
  - Fetch or normalize error: the run fails, the process continues.
  - Unhandled exception: exit 1; Railway restarts the process.

## Layout
```
worker/
  package.json            "name": "sphaerenmusik-worker", "type": "module", "engines": { "node": ">=24" }
  sources.json            source registry (sources.md)
  src/
    index.js              boot, scheduler loop, signal handling
    cli.js                one-off commands: --once <id>, clear-halt <id>
    registry.js           load and validate sources.json
    scheduler.js          due-time computation, per-host concurrency
    fetch.js              HTTP GET with User-Agent and timeout
    normalizers/          one module per normalizer name
    hash.js               canonicalJson, sha256
    store.js              Supabase RPC and table writes
    log.js                JSON-lines logger on stderr
  test/
    fixtures/             saved source responses
    *.test.js             node:test tests
```

## Process model
- One process, one event loop. The scheduler ticks every 1 s.
- A registry entry is due when it is enabled, not halted, not in backoff, and `now - last_attempt_at >= intervalSec`.
- At most one request runs per host. Due entries on the same host wait for the next tick.
- On start, the worker loads `source_status` and resumes each entry's schedule from its stored times.
- On `SIGTERM` or `SIGINT`, the worker stops scheduling, waits up to 10 s for in-flight runs, and exits 0.

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
| `halt` | Set `halted = true`, log `error` with event `halt`. No retry until `clear-halt`. |
| `retryAfter` | Wait the `Retry-After` header value in seconds, or 3600 s when absent. |
| `backoff` | Wait `min(intervalSec × 2^failures, maxBackoffSec)`. `failures` resets to 0 on success. |

A timeout or network error counts as a non-200 status.

## Environment variables
| Name | Example | Required |
|---|---|---|
| `SUPABASE_URL` | `https://abcd.supabase.co` | yes |
| `SUPABASE_SECRET_KEY` | `sb_secret_...` | yes |
| `WORKER_CONTACT` | `name@uchicago.edu` | yes |
| `LL2_BASE` | `https://ll.thespacedevs.com/2.3.0` | yes |
| `SOURCES_ENABLED` | `swpc.*,celestrak.stations` | no; default enables every entry with `enabled: true` |
| `LOG_LEVEL` | `warn` | no; default `warn` |

`SUPABASE_SECRET_KEY` bypasses row-level security. It exists only in Railway variables and in the local `worker/.env`, which is listed in `.gitignore`.

## Logs
The worker writes one JSON object per line to stderr. At the default level `warn`, a successful run writes nothing.
```json
{"t":"2026-10-29T14:00:00.123Z","level":"error","source":"celestrak.stations","event":"halt","status":403}
{"t":"2026-10-29T14:01:00.004Z","level":"warn","source":"jpl.cad","event":"version_mismatch","got":"1.6"}
{"t":"2026-10-29T14:02:00.010Z","level":"info","source":"swpc.wind","event":"run","ok":true,"rowsChanged":1,"ms":412}
```
Read production logs with `railway logs`.

## Local run
```bash
cd worker
npm ci
cp .env.example .env            # fill in the variables
node --env-file=.env src/cli.js --once swpc.wind
node --env-file=.env src/index.js
npm test                        # node --test
```

## Railway deployment
1. Verify the Railway account through GitHub at `https://railway.com/verify`. An unverified account runs as a Limited Trial with restricted outbound network access, and the worker cannot reach its sources.
2. Create a project: New Project → Deploy from GitHub repo → select the repository.
3. In the service settings set Root Directory `/worker`, Start Command `node src/index.js`, and Watch Paths `/worker/**`.
4. Set the environment variables in the service's Variables tab.
5. Set the restart policy to On Failure with a maximum of 10 retries.
6. Deploy. Confirm with `railway logs` and by querying `runs` through the Supabase MCP server.

Service settings live in the Railway dashboard. Railway stops reading `railway.json` config-as-code files on 2026-12-01; the repository contains none.

## Sources
- Railway docs, Deploying a Monorepo: https://docs.railway.com/deployments/monorepo
- Railway docs, Build Configuration: https://docs.railway.com/builds/build-configuration
- Railway docs, Free Trial: https://docs.railway.com/pricing/free-trial
- CelesTrak, Usage Policy: https://celestrak.org/usage-policy.php
- JPL SSD/CNEOS API service: https://ssd-api.jpl.nasa.gov/
