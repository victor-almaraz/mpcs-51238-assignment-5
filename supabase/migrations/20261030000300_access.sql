-- doc/database.md: Grants and RLS, Realtime publication.

alter table public.sky_objects           enable row level security;
alter table public.changes               enable row level security;
alter table public.runs                  enable row level security;
alter table public.source_status         enable row level security;
alter table public.source_samples        enable row level security;
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

alter publication supabase_realtime add table public.sky_objects;
