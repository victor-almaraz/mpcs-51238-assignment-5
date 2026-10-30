# Deployment

## Scope
The three hosted services, their environment variables, setup steps, free-tier limits and usage alerts.

## Services
| Service | Hosts | Plan |
|---|---|---|
| Vercel | Next.js page | Hobby |
| Supabase | Postgres, Realtime, `pg_cron`, `pg_net`, Edge Function `harvest` (the worker) | Free |
| Clerk | Sign-in | Free, development instance |

## Environment variables
| Variable | Vercel | Edge Function secrets | Local file |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | | `.env.local` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | | `.env.local` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | yes | | `.env.local` |
| `CLERK_SECRET_KEY` | yes | | `.env.local` |
| `SUPABASE_URL` | | injected | `worker/.env` |
| `SUPABASE_SECRET_KEY` | | injected as `SUPABASE_SECRET_KEYS` | `worker/.env` |
| `HARVEST_TOKEN` | | yes; also Vault `harvest_token` | |
| `WORKER_CONTACT` | | yes | `worker/.env` |
| `LL2_BASE` | | yes | `worker/.env` |
| `SOURCES_ENABLED` | | optional | `worker/.env` |
| `LOG_LEVEL` | | optional | `worker/.env` |

`.env.local` and `worker/.env` are in `.gitignore`. `.env.example` files list every name with no values.

## Supabase
1. Create a project in the region nearest to Chicago.
2. Enable the `pg_cron` and `pg_net` extensions (Database → Extensions).
3. Run each file in `supabase/migrations/` in the SQL editor, in file-name order.
4. Add Clerk as a third-party auth provider (`auth.md`).
5. Copy the publishable key to Vercel. The secret key stays in Supabase; the Edge Function receives it as `SUPABASE_SECRET_KEYS`.
6. Deploy the Edge Function and store the Vault secrets (`worker.md`, Deployment).
7. Confirm the `pg_cron` jobs exist: `select jobname, schedule from cron.job;`. The list includes `harvest` and the four prune jobs.

Free-plan limits relevant to this project:

| Limit | Value |
|---|---|
| Edge Function invocations | 500,000 per month, per organization; `harvest` uses about 44,640 |
| Edge Function CPU time | 2 s per invocation |
| Edge Function wall clock | 150 s per invocation |
| Realtime messages | 2,000,000 per month |
| Realtime concurrent connections | 200 |
| Realtime messages per second | 100 |
| Database size | 500 MB |
| Active projects | 2 |
| Inactivity pause | After 1 week without activity, with a warning email first |

The worker's writes keep the project active. Set a usage notification under Organization → Usage; the Free plan has no spend, so exceeding a quota starts a grace period instead of a charge. Open the deployed page at least once a week until grades are returned. The Usage page shows Realtime messages; check it daily during testing.

## Vercel
1. Import the GitHub repository. Framework preset: Next.js. Root directory: repository root. Build command: `npm run build`, which runs `npm run generate` (sandbox bundle, `builder.d.ts`, starter IR) before `next build`.
2. Set the environment variables for Production and Preview.
3. Each push to `main` deploys production; each pull request deploys a preview.
4. Confirm that the Vercel production domain is an allowed origin in the Clerk instance.

Hobby limits include 1,000,000 function invocations, 4 hours of active CPU and 100 GB of fast data transfer per month. Vercel sends usage notifications on Hobby; a Hobby project that exceeds its limits is paused until the next period.

`next.config.ts` sets the headers for `/dsl-sandbox.js` (`piece-dsl.md`). The app does not use `output: 'export'`, because Clerk requires server routes.

## Clerk
1. Create an application with email and GitHub sign-in.
2. Activate the Supabase integration (`auth.md`).
3. Add the Vercel production and preview domains to allowed origins.

## Submission
- Vercel URL of the deployed page.
- GitHub URL of the repository, with `README.md` and a commit history that shows progress.

## Sources
- Supabase, Pricing: https://supabase.com/pricing
- Supabase docs, Realtime Limits: https://supabase.com/docs/guides/realtime/limits
- Supabase docs, Free project pausing: https://supabase.com/docs/guides/platform/free-project-pausing
- Supabase docs, Edge Function limits: https://supabase.com/docs/guides/functions/limits
- Supabase docs, Edge Function invocations: https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations
- Vercel docs, Plans: https://vercel.com/docs/plans
- Vercel docs, Limits: https://vercel.com/docs/limits
