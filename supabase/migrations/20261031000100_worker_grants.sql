-- doc/database.md: Worker grants.

grant select, insert, update on public.source_status, public.source_samples to service_role;
grant insert on public.runs to service_role;
