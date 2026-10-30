-- doc/database.md: DDL.

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
  next_attempt_at  timestamptz
);

create table public.source_samples (
  source_id    text primary key,
  fetched_at   timestamptz not null,
  http_status  integer not null,
  body         text not null check (length(body) <= 65536)
);

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null default (auth.jwt() ->> 'sub'),
  name        text not null check (length(name) between 1 and 120),
  source      text not null default '' check (length(source) <= 200000),
  ir          jsonb,
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
  settings    jsonb not null default '{}',
  starters_version integer not null default 0,
  updated_at  timestamptz not null default now()
);
