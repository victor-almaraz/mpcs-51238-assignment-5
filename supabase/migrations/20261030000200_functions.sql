-- doc/database.md: Upsert RPC, Claim RPC, Starter seeding RPC.

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

create or replace function public.claim_source(
  p_source_id text, p_interval_sec integer, p_prev timestamptz)
returns boolean
language sql security definer set search_path = '' as $$
  with c as (
    insert into public.source_status as s (source_id, interval_sec, last_attempt_at)
    values (p_source_id, p_interval_sec, now())
    on conflict (source_id) do update
      set last_attempt_at = now(), interval_sec = excluded.interval_sec
      where s.last_attempt_at is not distinct from p_prev and not s.halted
    returning 1
  )
  select exists (select 1 from c);
$$;
revoke execute on function public.claim_source(text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_source(text, integer, timestamptz) to service_role;

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
  for r in select * from jsonb_array_elements(p_projects) loop
    insert into public.projects (user_id, name, source, ir, starter_slug)
    values (v_user, r ->> 'name', r ->> 'source', r -> 'ir', r ->> 'slug')
    on conflict (user_id, starter_slug) where starter_slug is not null do nothing
    returning id into v_id;
    if v_id is not null then
      insert into public.project_subscriptions (project_id, user_id, group_key)
      select v_id, v_user, g from jsonb_array_elements_text(r -> 'ir' -> 'groups') as g;
      n := n + 1;
    end if;
    v_id := null;
  end loop;
  update public.user_settings set starters_version = p_version, updated_at = now() where user_id = v_user;
  return n;
end $$;
revoke execute on function public.seed_starters(integer, jsonb) from public, anon;
grant execute on function public.seed_starters(integer, jsonb) to authenticated;
