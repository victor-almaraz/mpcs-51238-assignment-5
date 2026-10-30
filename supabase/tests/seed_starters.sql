-- Run in the Supabase SQL editor (doc/testing.md, Starter tests). Rolls back; raises on the first failure.
begin;

set local role authenticated;
set local request.jwt.claims = '{"sub":"user_test_a","role":"authenticated"}';
do $$
declare
  n integer;
  v1 constant jsonb := '[{"slug":"s1","name":"S1","source":"// s1","ir":{"groups":["swpc.wind"]}},
                         {"slug":"s2","name":"S2","source":"// s2","ir":{"groups":["swpc.kp","jpl.scout"]}}]';
begin
  n := public.seed_starters(1, v1);
  assert n = 2, format('first call: expected 2, got %s', n);
  assert (select count(*) from public.project_subscriptions) = 3, 'first call: subscriptions';
  assert (select starters_version from public.user_settings) = 1, 'first call: starters_version';

  n := public.seed_starters(1, v1);
  assert n = 0, format('second call: expected 0, got %s', n);

  update public.projects set deleted_at = now() where starter_slug = 's1';
  n := public.seed_starters(1, v1);
  assert n = 0, 'deleted starter is not recreated at the same version';

  n := public.seed_starters(2, v1 || '[{"slug":"s3","name":"S3","source":"// s3","ir":{"groups":[]}}]'::jsonb);
  assert n = 1, format('higher version: expected 1, got %s', n);
  assert (select count(*) from public.projects) = 3, 'higher version: only s3 added';
  perform set_config('test.a_project', (select id::text from public.projects limit 1), true);
end $$;

set local request.jwt.claims = '{"sub":"user_test_b","role":"authenticated"}';
do $$
declare
  n integer;
begin
  assert (select count(*) from public.projects) = 0, 'user b sees no projects of user a';
  n := public.seed_starters(1, '[{"slug":"s1","name":"S1","source":"","ir":{"groups":["swpc.wind"]}}]');
  assert n = 1, 'user b seeds own starter';
  assert (select count(*) from public.projects where user_id = 'user_test_b') = 1, 'user b owns the row';
  begin
    insert into public.projects (user_id, name) values ('user_test_a', 'intruder');
    raise exception 'user b inserted a project for user a';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.project_subscriptions (project_id, group_key)
    values (current_setting('test.a_project')::uuid, 'swpc.kp');
    raise exception 'user b subscribed user a''s project';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$
begin
  assert (select count(*) from public.projects where user_id = 'user_test_a') = 3, 'user a rows unchanged';
end $$;

select 'seed_starters.sql: all assertions passed' as result;
rollback;
