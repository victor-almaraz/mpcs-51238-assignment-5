-- Run in the Supabase SQL editor (doc/testing.md, SQL tests). Rolls back; raises on the first failure.
begin;

do $$
declare
  n integer;
  k text;
  o text;
  rows_ab constant jsonb := '[{"id":"test.group:a","fields":{"x":1},"hash":"h1"},
                              {"id":"test.group:b","fields":{"x":2},"hash":"h2"}]';
begin
  -- enter
  select count(*) into n from public.upsert_sky_objects('test.src', 'test.group', rows_ab, true);
  assert n = 2, format('enter: expected 2 changes, got %s', n);
  assert (select count(*) from public.changes where group_key = 'test.group' and kind = 'enter') = 2, 'enter: changes rows';
  assert (select count(distinct trace_id) from public.sky_objects where group_key = 'test.group') = 2, 'enter: one trace id per row';
  assert (select bool_and(s.trace_id = c.trace_id) from public.sky_objects s
          join public.changes c on c.object_id = s.id where s.group_key = 'test.group'), 'enter: trace ids match';

  -- unchanged
  select count(*) into n from public.upsert_sky_objects('test.src', 'test.group', rows_ab, true);
  assert n = 0, format('unchanged: expected 0 changes, got %s', n);

  -- update
  select count(*), max(out_kind) into n, k from public.upsert_sky_objects('test.src', 'test.group',
    '[{"id":"test.group:a","fields":{"x":3},"hash":"h1b"},{"id":"test.group:b","fields":{"x":2},"hash":"h2"}]', true);
  assert n = 1 and k = 'update', format('update: got %s %s', n, k);
  assert (select diff from public.changes where object_id = 'test.group:a' and kind = 'update')
         = '{"before":{"x":1},"after":{"x":3}}'::jsonb, 'update: diff';

  -- exit
  select count(*), max(out_kind), max(out_object_id) into n, k, o from public.upsert_sky_objects('test.src', 'test.group',
    '[{"id":"test.group:a","fields":{"x":3},"hash":"h1b"}]', true);
  assert n = 1 and k = 'exit' and o = 'test.group:b', format('exit: got %s %s %s', n, k, o);
  assert (select removed_at is not null from public.sky_objects where id = 'test.group:b'), 'exit: removed_at';

  -- p_full false never exits
  select count(*) into n from public.upsert_sky_objects('test.src', 'test.group', '[]', false);
  assert n = 0, 'partial: no exits';

  -- re-enter
  select count(*), max(out_kind) into n, k from public.upsert_sky_objects('test.src', 'test.group', rows_ab, true);
  assert n = 1 and k = 'enter', format('re-enter: got %s %s', n, k);
  assert (select removed_at is null from public.sky_objects where id = 'test.group:b'), 're-enter: removed_at cleared';

  -- claim_source: first claim, stale claim, halted (now() is fixed inside the transaction)
  assert public.claim_source('test.claim', 60, null, false) = 'claimed', 'claim: first';
  assert public.claim_source('test.claim', 60, null, false) = 'busy', 'claim: stale prev';
  update public.source_status set halted = true where source_id = 'test.claim';
  assert public.claim_source('test.claim', 60,
    (select last_attempt_at from public.source_status where source_id = 'test.claim'), false) = 'busy', 'claim: halted';

  -- claim_source, halt policy: open run, unfinished run, interval
  assert public.claim_source('test.halt', 7200, null, true) = 'claimed', 'halt claim: first';
  assert (select in_flight_at is not null from public.source_status where source_id = 'test.halt'), 'halt claim: in flight';
  assert public.claim_source('test.halt', 7200,
    (select last_attempt_at from public.source_status where source_id = 'test.halt'), true) = 'busy', 'halt claim: open run';
  update public.source_status set in_flight_at = now() - interval '11 minutes' where source_id = 'test.halt';
  assert public.claim_source('test.halt', 7200,
    (select last_attempt_at from public.source_status where source_id = 'test.halt'), true) = 'halted', 'halt claim: unfinished run';
  assert (select halted and in_flight_at is null from public.source_status where source_id = 'test.halt'), 'halt claim: halted';
  assert exists (select 1 from public.runs where source_id = 'test.halt' and not ok), 'halt claim: run recorded';
  insert into public.source_status (source_id, interval_sec, last_attempt_at, last_success_at)
  values ('test.interval', 7200, now() - interval '3 hours', now() - interval '1 hour');
  assert public.claim_source('test.interval', 7200, now() - interval '3 hours', true) = 'busy', 'halt claim: interval';

  -- claim_host / release_host
  assert public.claim_host('test.host', 'a', 150), 'lease: first';
  assert public.claim_host('test.host', 'a', 150), 'lease: same holder';
  assert not public.claim_host('test.host', 'b', 150), 'lease: held';
  perform public.release_host('test.host', 'a');
  assert public.claim_host('test.host', 'b', 150), 'lease: after release';
  update public.host_leases set expires_at = now() - interval '1 second' where host = 'test.host';
  assert public.claim_host('test.host', 'c', 150), 'lease: expired';
end $$;

set local role anon;
do $$
begin
  begin
    perform 1 from public.projects;
    raise exception 'anon can read projects';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.upsert_sky_objects('x', 'x', '[]', false);
    raise exception 'anon can execute upsert_sky_objects';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.claim_source('x', 60, null, false);
    raise exception 'anon can execute claim_source';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.claim_host('x', 'x', 1);
    raise exception 'anon can execute claim_host';
  exception when insufficient_privilege then null;
  end;
  assert (select count(*) from public.sky_objects where group_key = 'test.group') = 2, 'anon reads sky_objects';
end $$;
reset role;

select 'upsert.sql: all assertions passed' as result;
rollback;
