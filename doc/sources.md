# Sources

## Scope
External data sources, their usage rules, the source registry and normalization to `SkyObject`. Schedules and failure policies are data in `supabase/functions/harvest/sources.json`; worker code contains no per-source timing.

## Source table
| Registry id | Group | Endpoint | Interval | Key | Failure policy |
|---|---|---|---|---|---|
| `celestrak.stations` | `celestrak.stations` | `https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json` | 7500 s | `NORAD_CAT_ID` | `halt` |
| `celestrak.gps-ops` | `celestrak.gps-ops` | `...?GROUP=gps-ops&FORMAT=json` | 7500 s | `NORAD_CAT_ID` | `halt` |
| `celestrak.visual` | `celestrak.visual` | `...?GROUP=visual&FORMAT=json` | 7500 s | `NORAD_CAT_ID` | `halt` |
| `celestrak.cosmos-2251-debris` | `celestrak.cosmos-2251-debris` | `...?GROUP=cosmos-2251-debris&FORMAT=json` | 7500 s | `NORAD_CAT_ID` | `halt` |
| `swpc.kp` | `swpc.kp` | `https://services.swpc.noaa.gov/json/planetary_k_index_1m.json` | 60 s | constant `planetary` | `backoff` |
| `swpc.wind` | `swpc.wind` | `https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json` | 60 s | constant `l1` | `backoff` |
| `swpc.mag` | `swpc.mag` | `https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json` | 60 s | constant `l1` | `backoff` |
| `jpl.cad` | `jpl.cad` | `https://ssd-api.jpl.nasa.gov/cad.api?dist-max=10LD&date-min=now&date-max=%2B60` | 21600 s | `des` + `cd` | `backoff` |
| `jpl.scout` | `jpl.scout` | `https://ssd-api.jpl.nasa.gov/scout.api` | 900 s | `objectName` | `backoff` |
| `ll2.upcoming` | `ll2.upcoming` | `${LL2_BASE}/launches/upcoming/?limit=10&mode=normal` | 600 s | `id` | `retryAfter` |

No source requires an API key. The worker sends `User-Agent: Sphaerenmusik/<version> (<WORKER_CONTACT>)` to every host.

The ISS position is not a worker source. The browser propagates the ISS record from `celestrak.stations` with `satellite.js` (`visuals.md`). Streaming a position every few seconds through Realtime exceeds the free message quota.

## Source classes
Every value the sky provides belongs to one class. The class determines which DSL construct fits it.

| Class | Behavior | Values | Fits |
|---|---|---|---|
| VLFO | Periodic and continuous; computable for any instant | Orbital motion of `celestrak.*` objects: latitude, orbital phase, altitude, longitude, sunlight, elevation (`piece-dsl.md`, Orbits) | `orbit(...)` in modulation, `follow`, voice options and layers |
| Step function | Constant between updates; changes in discrete steps | Orbital elements (`celestrak.*` fields), close approaches (`jpl.cad`), Scout scores, launch fields (`ll2.upcoming`) | `follow`, voice selection and pitch |
| Random walk | Continuous and aperiodic; changes every update | Kp (`swpc.kp`), solar wind (`swpc.wind`), magnetic field (`swpc.mag`) | Data modulation, `follow` |
| Trigger | A discrete event at one instant | `enter`, `update` and `exit` of any object; Scout candidates appearing; launch status changes | `on(...).trigger(...)` |

Orbital elements are the step function that sets each VLFO's rate and phase: an element update moves an orbit VLFO's phase by the correction CelesTrak publishes, without a discontinuity larger than that correction.

## CelesTrak
- Domain: `celestrak.org` only. An HTTP 301 indicates a wrong domain or legacy URL; treat it as a failure.
- GP data updates once every 2 hours. CelesTrak enforces one download per update for each group (enforced from 2026-03-26). A second download before the next update returns HTTP 403 with a text explanation.
- Policy `halt`: any non-200 response sets `source_status.halted = true` for that registry id. The worker makes no further requests to it until a human clears the halt (`worker.md`, Failure policies). Repeated failing requests can put the worker's IP on CelesTrak's firewall.
- The worker persists `last_success_at` per registry id and never fetches a group before `last_success_at + interval`, including after a restart.
- Format: OMM JSON (`FORMAT=json`). Catalog numbers assigned from 2026-07-11 have six digits (the `stations` group already contains `101031`); the TLE format cannot represent them. `NORAD_CAT_ID` arrives as a JSON number; the normalizer stores it as a decimal string.
- Edge Functions have no static egress IP; the address is shared with other workloads. A download of the same group by another workload from the same address can produce a 403 for this worker, which halts the source like any other non-200 response.
- An HTTP 200 response can carry a plain-text body such as "No GP data found". The normalizer rejects any body that is not a JSON array.
- The `active` group (over 10,000 objects) is not a registry source.

| Field | OMM key | Unit |
|---|---|---|
| `name` | `OBJECT_NAME` | |
| `objectId` | `OBJECT_ID` | |
| `noradId` | `NORAD_CAT_ID` | |
| `epoch` | `EPOCH` | ISO 8601 UTC |
| `meanMotion` | `MEAN_MOTION` | rev/day |
| `eccentricity` | `ECCENTRICITY` | |
| `inclination` | `INCLINATION` | deg |
| `raan` | `RA_OF_ASC_NODE` | deg |
| `argPericenter` | `ARG_OF_PERICENTER` | deg |
| `meanAnomaly` | `MEAN_ANOMALY` | deg |
| `bstar` | `BSTAR` | |
| `meanMotionDot` | `MEAN_MOTION_DOT` | |
| `meanMotionDdot` | `MEAN_MOTION_DDOT` | |
| `ephemerisType` | `EPHEMERIS_TYPE` | |
| `classification` | `CLASSIFICATION_TYPE` | |
| `elementSetNo` | `ELEMENT_SET_NO` | |
| `revAtEpoch` | `REV_AT_EPOCH` | |

`src/sky/omm.js` exports `toOmm(fields)`, which restores the OMM keys for `satellite.json2satrec`.

## NOAA SWPC
- SWPC restructured its JSON products under Service Change Notice 26-21 (effective 2026-03-31). `products/solar-wind/*.json` returns 404. Solar wind comes from `json/rtsw/`.
- RTSW files hold 24 hours of one-minute rows, newest first, one row per spacecraft per minute. Each row carries `source` (spacecraft) and `active` (the forecaster-selected primary). The normalizer selects the first row with `active === true` and records its `source` in `spacecraft`. The spacecraft name is data; code does not assume one.
- Before `JSON.parse`, strip trailing `\u0000` bytes. After parsing, map `-9999` and `null` to `null`.
- The Kp file is an array of row objects. The normalizer takes the row with the latest `time_tag`.

| Group | Field | Source key | Unit |
|---|---|---|---|
| `swpc.kp` | `kp` | `kp_index` | 0–9 |
| `swpc.kp` | `kpEstimated` | `estimated_kp` | 0–9 |
| `swpc.kp` | `timeTag` | `time_tag` | ISO 8601 UTC |
| `swpc.wind` | `speed` | `proton_speed` | km/s |
| `swpc.wind` | `density` | `proton_density` | p/cm³ |
| `swpc.wind` | `temperature` | `proton_temperature` | K |
| `swpc.wind` | `spacecraft` | `source` | |
| `swpc.wind` | `timeTag` | `time_tag` | ISO 8601 UTC |
| `swpc.mag` | `bt` | `bt` | nT |
| `swpc.mag` | `bz` | `bz_gsm` | nT |
| `swpc.mag` | `spacecraft` | `source` | |
| `swpc.mag` | `timeTag` | `time_tag` | ISO 8601 UTC |

## JPL SSD/CNEOS
- `ssd-api.jpl.nasa.gov` presents a chain that ends at Sectigo Public Server Authentication Root R46. Node.js and Deno bundle that root; the macOS `/etc/ssl/cert.pem` lacks it, so `curl` on macOS fails verification unless given a current CA bundle.
- The SSD/CNEOS fair-use policy requires one request at a time, no unnecessary repeated requests, caching of results, and backing off on errors. Browsers may not call these APIs; only the worker does.
- Check `signature.version` in every response. CAD documents version `1.5`. A different version logs `warn` with event `version_mismatch` and the run still proceeds; a missing field fails normalization.
- CAD returns `fields` (column names) and `data` (rows). Zip them into objects. `count: 0` with HTTP 200 is a valid empty result.
- CAD returns every value as a string. The normalizer converts numeric columns with `Number` and maps non-finite results to `null`. `cd` has the form `2026-Oct-31 02:35`.
- Scout returns `signature.version` `1.3`, `count` as a string, and a `data` array of candidate objects. `neoScore`, `phaScore`, `nObs` and `rating` arrive as numbers; `H`, `arc` and `vInf` arrive as strings or `null`. The normalizer converts them to numbers. `tEphem` advances on every Scout run and is not a field, so an unchanged candidate does not produce an update.

| Group | Field | Source key | Unit |
|---|---|---|---|
| `jpl.cad` | `des` | `des` | |
| `jpl.cad` | `closeApproach` | `cd` | TDB calendar date |
| `jpl.cad` | `distAu` | `dist` | au |
| `jpl.cad` | `distLD` | `dist` × 389.17 | lunar distances |
| `jpl.cad` | `vRel` | `v_rel` | km/s |
| `jpl.cad` | `vInf` | `v_inf` | km/s |
| `jpl.cad` | `h` | `h` | mag |
| `jpl.scout` | `objectName` | `objectName` | |
| `jpl.scout` | `neoScore` | `neoScore` | 0–100 |
| `jpl.scout` | `phaScore` | `phaScore` | 0–100 |
| `jpl.scout` | `nObs` | `nObs` | |
| `jpl.scout` | `arc` | `arc` | days |
| `jpl.scout` | `h` | `H` | mag |
| `jpl.scout` | `vInf` | `vInf` | km/s |
| `jpl.scout` | `rating` | `rating` | |
| `jpl.scout` | `lastRun` | `lastRun` | |

## Launch Library 2
- Anonymous access allows 15 requests per hour per IP. HTTP 429 carries `Retry-After`; policy `retryAfter` waits that many seconds, or 3600 s when the header is absent.
- `mode=normal` is required: `mode=list` omits `launch_service_provider` and `pad`. A `limit=10` response is about 90 KB.
- `pad.latitude` and `pad.longitude` arrive as numbers.
- `LL2_BASE` is `https://lldev.thespacedevs.com/2.3.0` in development (stale data, no rate limit) and `https://ll.thespacedevs.com/2.3.0` in production.

| Field | Source key |
|---|---|
| `name` | `name` |
| `net` | `net` |
| `status` | `status.abbrev` |
| `provider` | `launch_service_provider.name` |
| `padLat` | `pad.latitude` |
| `padLon` | `pad.longitude` |

## Registry entry
```json
{
  "id": "swpc.wind",
  "group": "swpc.wind",
  "url": "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json",
  "intervalSec": 60,
  "timeoutMs": 10000,
  "normalizer": "swpcRtsw",
  "normalizerArgs": { "kind": "wind" },
  "full": true,
  "onNon200": "backoff",
  "maxBackoffSec": 900,
  "enabled": true
}
```

| Key | Meaning |
|---|---|
| `id` | Registry id, unique; also the `runs.source_id` |
| `group` | Group key written to `sky_objects.group_key` |
| `url` | Request URL; `${LL2_BASE}` is substituted at boot |
| `intervalSec` | Minimum seconds between attempts |
| `timeoutMs` | Request timeout |
| `normalizer` | Name in `worker/src/normalizers/index.js` |
| `normalizerArgs` | Static arguments passed to the normalizer |
| `full` | `true` when each response lists the whole group; objects absent from it get `removed_at` |
| `onNon200` | `halt`, `retryAfter` or `backoff` |
| `maxBackoffSec` | Upper bound for `backoff` |
| `enabled` | Disabled entries are never scheduled |

## Normalization
```ts
type SkyObject = {
  id: string;                 // `${group}:${key}`
  source: string;             // registry id
  group: string;
  fields: Record<string, number | string | boolean | null>;
};
```
- `fields` is flat. Numbers are finite or `null`.
- The change key is `sha256(canonicalJson(fields))`, where `canonicalJson` sorts keys.
- An object that appears in several groups (the ISS in `stations` and `visual`) is stored once per group.

## Attribution
The page footer and console show: "Orbital data: CelesTrak. Space weather: NOAA SWPC. Close approaches and Scout: NASA/JPL CNEOS. Launches: The Space Devs, Launch Library 2."

## Saved responses
`worker/test/fixtures/captures.jsonl` lists each saved response with its URL, time, status and size, and names the source of each derived fixture. Observations from two captures on 2026-10-30: five minutes apart for SWPC, JPL and LL2; 2 h 17 min apart for CelesTrak, to stay within one download per GP update:

| Source | Objects | Change between captures |
|---|---|---|
| `celestrak.stations` | 20 | None. A request five minutes after the first also returned HTTP 200 with an identical body, not 403 |
| `celestrak.gps-ops` | 32 | None |
| `celestrak.visual` | 156 | None |
| `celestrak.cosmos-2251-debris` | 585 | None |
| `swpc.kp` | 1 | Latest row moved from 02:29 to 02:33; values unchanged |
| `swpc.wind` | 1 | Active row moved from 02:26 to 02:31; speed, density and temperature changed |
| `swpc.mag` | 1 | Active row moved from 02:24 to 02:31; `bt` and `bz` changed |
| `jpl.cad` | 8 | None |
| `jpl.scout` | 26 | Only `tEphem` and two minor fields of two candidates |
| `ll2.upcoming` | 10 | None (`mode=normal`) |

No CelesTrak group published new elements between 02:33 and 04:50 UTC, so the second captures equal the first: a group's elements change less often than the 2-hour GP cycle. In RTSW files the newest row is not active (an `ACE` or `IMAP` row precedes the active `SOLAR1` row). `-9999` appears in `rtsw_mag_1m.json`; no trailing NUL bytes appeared.

## Sources
- CelesTrak, Usage Policy: https://celestrak.org/usage-policy.php
- CelesTrak, A New Way to Obtain GP Data: https://celestrak.org/NORAD/documentation/gp-data-formats.php
- NWS Service Change Notice 26-21: https://www.weather.gov/media/notification/pdf_2026/scn26-21_Data_Format_Changes_Impacting_SWPC_Products.pdf
- NOAA SWPC, Real-Time Solar Wind: https://www.swpc.noaa.gov/products/real-time-solar-wind
- JPL SSD/CNEOS API service and fair-use policy: https://ssd-api.jpl.nasa.gov/
- JPL SBDB Close Approach Data API: https://ssd-api.jpl.nasa.gov/doc/cad.html
- The Space Devs, Launch Library 2 FAQ: https://github.com/TheSpaceDevs/Tutorials/blob/main/faqs/faq_LL2.md
