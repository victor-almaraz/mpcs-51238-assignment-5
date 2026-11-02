# Database

## Scope
Tables, the upsert RPC, grants, row-level security (RLS), the Realtime publication, retention jobs and the free-tier message budget. All of it ships as SQL files in `supabase/migrations/`.

## Tables
| Table | Writer | Readers | Purpose |
|---|---|---|---|
| `sky_objects` | Worker | Everyone | Current state of every object |
| `changes` | Worker (RPC) | Everyone | Log of enter, update and exit events; replay source |
| `runs` | Worker; `claim_source` | Everyone | One row per run; `claim_source` adds one when it halts a source |
| `source_status` | Worker | Everyone | Schedule state and last outcome per registry id |
| `source_samples` | Worker | Everyone | Last raw response per registry id |
| `host_leases` | Worker (RPC) | Nobody | One lease per source host, so overlapping invocations never send two requests to one host |
| `projects` | Owner | Owner | Script source and compiled IR |
| `project_subscriptions` | Owner | Owner | Groups each project follows |
| `user_settings` | Owner | Owner | Settings JSON |

## DDL
```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

create table public.sky_objects (
  id          text primary key,
  source      text not null,
  group_key   text not null,
  fields      jsonb not null,
  hash        text not null,
  trace_id    uuid not null,
  updated_at  timestamptz not null default now(),
  removed_at  timestamptz
);
create index sky_objects_group_live on public.sky_objects (group_key) where removed_at is null;

create table public.changes (
  id          bigint generated always as identity primary key,
  trace_id    uuid not null,
  source      text not null,
  group_key   text not null,
  object_id   text not null,
  kind        text not null check (kind in ('enter', 'update', 'exit')),
  diff        jsonb not null,
  at          timestamptz not null default now()
);
create index changes_group_at on public.changes (group_key, at);

create table public.runs (
  id            bigint generated always as identity primary key,
  source_id     text not null,
  started_at    timestamptz not null,
  finished_at   timestamptz not null,
  ok            boolean not null,
  rows_changed  integer not null default 0,
  http_status   integer,
  error         text
);
create index runs_source_started on public.runs (source_id, started_at desc);

create table public.source_status (
  source_id        text primary key,
  interval_sec     integer not null,
  last_attempt_at  timestamptz,
  last_success_at  timestamptz,
  last_ok          boolean,
  halted           boolean not null default false,
  failures         integer not null default 0,
  next_attempt_at  timestamptz,
  in_flight_at     timestamptz
);

create table public.source_samples (
  source_id    text primary key,
  fetched_at   timestamptz not null,
  http_status  integer not null,
  body         text not null check (length(body) <= 65536)
);

create table public.host_leases (
  host        text primary key,
  holder      text not null,
  expires_at  timestamptz not null
);

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null default (auth.jwt() ->> 'sub'),
  name        text not null check (length(name) between 1 and 120),
  source      text not null default '' check (length(source) <= 200000),
  ir          jsonb check (ir is null or octet_length(ir::text) <= 1000000),
  ir_version  integer not null default 1,
  local_only  boolean not null default false,
  starter_slug text,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index projects_user on public.projects (user_id) where deleted_at is null;
create unique index projects_user_starter on public.projects (user_id, starter_slug) where starter_slug is not null;

create table public.project_subscriptions (
  project_id  uuid not null references public.projects (id) on delete cascade,
  user_id     text not null default (auth.jwt() ->> 'sub'),
  group_key   text not null,
  primary key (project_id, group_key)
);
create index project_subscriptions_user on public.project_subscriptions (user_id);

create table public.user_settings (
  user_id     text primary key default (auth.jwt() ->> 'sub'),
  settings    jsonb not null default '{}' check (octet_length(settings::text) <= 16384),
  starters_version integer not null default 0,
  updated_at  timestamptz not null default now()
);
```
Clerk user ids (`user_...`) are not UUIDs. Every `user_id` column is `text` and is compared with `auth.jwt() ->> 'sub'`. `auth.uid()` is not used.

## Upsert RPC
All CTEs in one statement read the same snapshot, so `prev` holds the values before the write. `incoming` calls a volatile function, so Postgres materializes it once and each row keeps one trace id. The trace id is written to both `sky_objects` and `changes`, so every Realtime payload carries it.
```sql
create or replace function public.upsert_sky_objects(
  p_source text, p_group text, p_rows jsonb, p_full boolean)
returns table (out_object_id text, out_kind text, out_trace_id uuid)
language sql security definer set search_path = '' as $$
  with incoming as (
    select r ->> 'id' as id, r -> 'fields' as fields, r ->> 'hash' as hash,
           gen_random_uuid() as trace_id
    from jsonb_array_elements(p_rows) as r
  ),
  prev as (
    select t.id, t.fields, t.removed_at
    from public.sky_objects t
    where t.group_key = p_group
  ),
  up as (
    insert into public.sky_objects as t (id, source, group_key, fields, hash, trace_id)
    select i.id, p_source, p_group, i.fields, i.hash, i.trace_id from incoming i
    on conflict (id) do update
      set fields = excluded.fields, hash = excluded.hash, trace_id = excluded.trace_id,
          updated_at = now(), removed_at = null
      where t.hash is distinct from excluded.hash or t.removed_at is not null
    returning t.id, t.fields, t.trace_id
  ),
  gone as (
    update public.sky_objects t
      set removed_at = now(), updated_at = now(), trace_id = gen_random_uuid()
    where p_full and t.group_key = p_group and t.removed_at is null
      and not exists (select 1 from incoming i where i.id = t.id)
    returning t.id, t.fields, t.trace_id
  ),
  ch as (
    insert into public.changes (trace_id, source, group_key, object_id, kind, diff)
    select up.trace_id, p_source, p_group, up.id,
           case when p.id is null or p.removed_at is not null then 'enter' else 'update' end,
           jsonb_build_object('before', p.fields, 'after', up.fields)
    from up left join prev p on p.id = up.id
    union all
    select g.trace_id, p_source, p_group, g.id, 'exit',
           jsonb_build_object('before', g.fields, 'after', null)
    from gone g
    returning object_id, kind, trace_id
  )
  select object_id, kind, trace_id from ch;
$$;

revoke execute on function public.upsert_sky_objects(text, text, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.upsert_sky_objects(text, text, jsonb, boolean)
  to service_role;
```
`p_full` is the registry entry's `full` value.

## Claim RPC
The worker claims a due entry before fetching it. The claim returns `claimed`, `busy` or `halted`.
- `claimed` only when `last_attempt_at` still holds the value the worker read and the source is not halted, so two overlapping invocations never fetch the same source.
- For entries with failure policy `halt` (`p_halt_policy`), the claim also requires `now() − last_success_at ≥ interval` and no open run, and sets `in_flight_at`. Every `source_status` write after the run, success or failure, clears it. The interval check in SQL holds for every caller, including `cli.js --once`.
- A halt-policy run whose `in_flight_at` is older than 10 minutes never recorded its result (the invocation was killed, or a write failed after the fetch). The next claim sets `halted = true` and `last_ok = false`, inserts a failed `runs` row and returns `halted`. The halt therefore fails closed: losing a response never resumes fetching. The 10 minutes exceed the 150 s Edge Function wall clock.
```sql
create or replace function public.claim_source(
  p_source_id text, p_interval_sec integer, p_prev timestamptz, p_halt_policy boolean)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_since timestamptz;
begin
  if p_halt_policy then
    select s.in_flight_at into v_since from public.source_status s
    where s.source_id = p_source_id and not s.halted
      and s.in_flight_at < now() - interval '10 minutes'
    for update;
    if found then
      update public.source_status set halted = true, last_ok = false, in_flight_at = null
      where source_id = p_source_id;
      insert into public.runs (source_id, started_at, finished_at, ok, error)
      values (p_source_id, v_since, now(), false, 'previous run did not record its result; halted');
      return 'halted';
    end if;
  end if;
  insert into public.source_status as s (source_id, interval_sec, last_attempt_at, in_flight_at)
  values (p_source_id, p_interval_sec, now(), case when p_halt_policy then now() end)
  on conflict (source_id) do update
    set last_attempt_at = now(), interval_sec = excluded.interval_sec, in_flight_at = excluded.in_flight_at
    where s.last_attempt_at is not distinct from p_prev and not s.halted
      and (not p_halt_policy or (s.in_flight_at is null
           and (s.last_success_at is null
                or s.last_success_at <= now() - make_interval(secs => p_interval_sec))));
  if found then return 'claimed'; end if;
  return 'busy';
end $$;
revoke execute on function public.claim_source(text, integer, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_source(text, integer, timestamptz, boolean) to service_role;
```

## Host lease RPC
A tick holds a lease on each host while it runs that host's queue (`worker.md`, Invocation model). The lease expires on its own after `p_ttl_sec`, so a killed invocation releases it.
```sql
create or replace function public.claim_host(p_host text, p_holder text, p_ttl_sec integer)
returns boolean
language sql security definer set search_path = '' as $$
  with c as (
    insert into public.host_leases as h (host, holder, expires_at)
    values (p_host, p_holder, now() + make_interval(secs => p_ttl_sec))
    on conflict (host) do update
      set holder = excluded.holder, expires_at = excluded.expires_at
      where h.expires_at <= now() or h.holder = excluded.holder
    returning 1
  )
  select exists (select 1 from c);
$$;
create or replace function public.release_host(p_host text, p_holder text)
returns void
language sql security definer set search_path = '' as $$
  delete from public.host_leases where host = p_host and holder = p_holder;
$$;
revoke execute on function public.claim_host(text, text, integer) from public, anon, authenticated;
revoke execute on function public.release_host(text, text) from public, anon, authenticated;
grant execute on function public.claim_host(text, text, integer) to service_role;
grant execute on function public.release_host(text, text) to service_role;
```

## Starter seeding RPC
Runs as the calling user (`security invoker`), so the RLS policies on `projects`, `project_subscriptions` and `user_settings` apply.
```sql
create or replace function public.seed_starters(p_version integer, p_projects jsonb)
returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  v_user text := auth.jwt() ->> 'sub';
  v_have integer;
  r jsonb;
  v_id uuid;
  n integer := 0;
begin
  insert into public.user_settings (user_id) values (v_user) on conflict (user_id) do nothing;
  select starters_version into v_have from public.user_settings where user_id = v_user for update;
  if v_have >= p_version then return 0; end if;
  if jsonb_typeof(p_projects) is distinct from 'array' then
    raise exception 'seed_starters: p_projects must be a JSON array';
  end if;
  for r in select * from jsonb_array_elements(p_projects) loop
    insert into public.projects (user_id, name, source, ir, starter_slug)
    values (v_user, r ->> 'name', coalesce(r ->> 'source', ''), r -> 'ir', r ->> 'slug')
    on conflict (user_id, starter_slug) where starter_slug is not null do nothing
    returning id into v_id;
    if v_id is not null then
      insert into public.project_subscriptions (project_id, user_id, group_key)
      select distinct v_id, v_user, g
      from jsonb_array_elements_text(case when jsonb_typeof(r -> 'ir' -> 'groups') = 'array'
                                          then r -> 'ir' -> 'groups' else '[]' end) as g;
      n := n + 1;
    end if;
    v_id := null;
  end loop;
  update public.user_settings set starters_version = p_version, updated_at = now() where user_id = v_user;
  return n;
end $$;
revoke execute on function public.seed_starters(integer, jsonb) from public, anon;
grant execute on function public.seed_starters(integer, jsonb) to authenticated;
```
The unique index `projects_user_starter` covers deleted rows until `prune-projects` removes them; a starter deleted before a manifest `version` increase is recreated only if the prune job has already removed its row.

## Grants and RLS
Postgres checks grants before policies. A missing grant returns error `42501`. A missing or failing policy returns zero rows, and Realtime delivers nothing.
```sql
alter table public.sky_objects           enable row level security;
alter table public.changes               enable row level security;
alter table public.runs                  enable row level security;
alter table public.source_status         enable row level security;
alter table public.source_samples        enable row level security;
alter table public.host_leases           enable row level security;
alter table public.projects              enable row level security;
alter table public.project_subscriptions enable row level security;
alter table public.user_settings         enable row level security;

revoke all on all tables in schema public from anon, authenticated;

-- Public sky data
grant select on public.sky_objects, public.changes, public.runs,
                public.source_status, public.source_samples to anon, authenticated;
create policy sky_objects_read    on public.sky_objects    for select to anon, authenticated using (true);
create policy changes_read        on public.changes        for select to anon, authenticated using (true);
create policy runs_read           on public.runs           for select to anon, authenticated using (true);
create policy source_status_read  on public.source_status  for select to anon, authenticated using (true);
create policy source_samples_read on public.source_samples for select to anon, authenticated using (true);

-- Owner data
grant select, insert, update, delete
  on public.projects, public.project_subscriptions, public.user_settings to authenticated;

create policy projects_select on public.projects for select to authenticated
  using ((select auth.jwt() ->> 'sub') = user_id);
create policy projects_insert on public.projects for insert to authenticated
  with check ((select auth.jwt() ->> 'sub') = user_id);
create policy projects_update on public.projects for update to authenticated
  using ((select auth.jwt() ->> 'sub') = user_id)
  with check ((select auth.jwt() ->> 'sub') = user_id);
create policy projects_delete on public.projects for delete to authenticated
  using ((select auth.jwt() ->> 'sub') = user_id);

create policy subs_select on public.project_subscriptions for select to authenticated
  using ((select auth.jwt() ->> 'sub') = user_id);
create policy subs_insert on public.project_subscriptions for insert to authenticated
  with check (
    (select auth.jwt() ->> 'sub') = user_id
    and exists (select 1 from public.projects p
                where p.id = project_id and p.user_id = (select auth.jwt() ->> 'sub')));
create policy subs_delete on public.project_subscriptions for delete to authenticated
  using ((select auth.jwt() ->> 'sub') = user_id);

create policy settings_select on public.user_settings for select to authenticated
  using ((select auth.jwt() ->> 'sub') = user_id);
create policy settings_insert on public.user_settings for insert to authenticated
  with check ((select auth.jwt() ->> 'sub') = user_id);
create policy settings_update on public.user_settings for update to authenticated
  using ((select auth.jwt() ->> 'sub') = user_id)
  with check ((select auth.jwt() ->> 'sub') = user_id);
```
The `subs_insert` check prevents a user from attaching subscriptions to another user's project.

### Worker grants
The worker connects with the secret key and runs as `service_role`, which bypasses RLS but still needs table grants. Default privileges in `public` give `service_role` no `select`, `insert`, `update` or `delete` on tables that `postgres` creates, so each grant is explicit. The worker writes `sky_objects`, `changes` and `host_leases` only through the security-definer RPCs, and reaches three tables directly (`store.js`): it reads and upserts `source_status` and clears halts there, upserts `source_samples`, and inserts `runs`.
```sql
grant select, insert, update on public.source_status, public.source_samples to service_role;
grant insert on public.runs to service_role;
```

## Realtime publication
```sql
alter publication supabase_realtime add table public.sky_objects;
```
Realtime delivers a row change only when all three conditions hold:
1. The table is in `supabase_realtime`.
2. The client's role (`anon` or `authenticated`) has `select` on the table.
3. An RLS policy lets that role read the row.

If any one is missing, the channel subscribes without error and receives nothing.

Delivery rules:
- Clients subscribe with the filter `group_key=in.(g1,g2,...)` (up to 100 values).
- `DELETE` events are not filtered by RLS. The schema never deletes sky rows that clients watch; it sets `removed_at`, which arrives as an `UPDATE`.
- `source_status` is not in the publication. The sky store reads it by REST every 30 s (`STATUS_POLL_MS` in `src/sky/freshness.js`; `sky-contract.md`).

## Retention
```sql
select cron.schedule('prune-changes', '17 * * * *',
  $$delete from public.changes where at < now() - interval '7 days'$$);
select cron.schedule('prune-runs', '23 * * * *',
  $$delete from public.runs where started_at < now() - interval '3 days'$$);
select cron.schedule('prune-removed', '41 3 * * *',
  $$delete from public.sky_objects where removed_at < now() - interval '1 day'$$);
select cron.schedule('prune-projects', '53 3 * * *',
  $$delete from public.projects where deleted_at < now() - interval '1 day'$$);
```
Rows removed by `prune-removed` already carry `removed_at`, so clients have received their exit before the delete.

## Harvest schedule
The cron job reads the project URL and the harvest token from Vault at run time. The migration creates the job; it sends nothing until a human stores the two Vault secrets once in the SQL editor:
```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<HARVEST_TOKEN value>', 'harvest_token');
```
```sql
select cron.schedule('harvest', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/harvest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                     where name = 'harvest_token')),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000)
  where exists (select 1 from vault.decrypted_secrets where name = 'project_url')
    and exists (select 1 from vault.decrypted_secrets where name = 'harvest_token')
$$);
```
`pg_net` writes the header to `net.http_request_queue` until the request is sent. The header carries `HARVEST_TOKEN`, which can only start a tick; it never carries the secret key.

## Free-tier message budget
Realtime counts one message per change per subscribed client.

| Stream | Changes per month | Messages per client-month |
|---|---|---|
| `swpc.kp`, `swpc.wind`, `swpc.mag` (1 per minute each) | 129,600 | 129,600 |
| `celestrak.stations` and `celestrak.gps-ops` (52 objects, at most one update per 7500 s each) | at most about 18,000 | at most about 18,000 |
| `jpl.*`, `ll2.upcoming` | under 2,000 | under 2,000 |
| Total, client following every group above | | about 150,000 |

The 2,000,000-message Free quota covers about 13 continuously open client-months. Each further CelesTrak group adds at most 11.5 messages per object per day per client: `celestrak.visual` (156 objects) adds up to about 54,000 and `celestrak.cosmos-2251-debris` (585 objects) up to about 202,000 messages per client-month. Object counts are those of the saved responses (`sources.md`, Saved responses). The page closes its Realtime channel 60 s after the tab becomes hidden and resubscribes, with a fresh select, when it becomes visible.

## Sources
- Supabase docs, Postgres Changes: https://supabase.com/docs/guides/realtime/postgres-changes
- Supabase docs, Row Level Security: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase docs, Realtime Limits: https://supabase.com/docs/guides/realtime/limits
- Supabase docs, Cron: https://supabase.com/docs/guides/cron
- Supabase docs, Scheduling Edge Functions: https://supabase.com/docs/guides/functions/schedule-functions
- Supabase docs, pg_net: https://supabase.com/docs/guides/database/extensions/pg_net
- Clerk docs, Integrate Supabase with Clerk: https://clerk.com/docs/guides/development/integrations/databases/supabase
