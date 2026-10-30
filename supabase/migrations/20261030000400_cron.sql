-- doc/database.md: Retention, Harvest schedule. Store the Vault secrets project_url and harvest_token before the harvest job first runs.

select cron.schedule('prune-changes', '17 * * * *',
  $$delete from public.changes where at < now() - interval '7 days'$$);
select cron.schedule('prune-runs', '23 * * * *',
  $$delete from public.runs where started_at < now() - interval '3 days'$$);
select cron.schedule('prune-removed', '41 3 * * *',
  $$delete from public.sky_objects where removed_at < now() - interval '1 day'$$);
select cron.schedule('prune-projects', '53 3 * * *',
  $$delete from public.projects where deleted_at < now() - interval '1 day'$$);

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
$$);
