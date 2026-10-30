# Deployment

## Scope
The four hosted services, their environment variables, setup steps, free-tier limits and usage alerts.

## Services
| Service | Hosts | Plan |
|---|---|---|
| Vercel | Next.js page | Hobby |
| Railway | Worker | Trial, then Free or Hobby |
| Supabase | Postgres, Realtime, `pg_cron` | Free |
| Clerk | Sign-in | Free, development instance |

## Environment variables
| Variable | Vercel | Railway | Local file |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | | `.env.local` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | | `.env.local` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | yes | | `.env.local` |
| `CLERK_SECRET_KEY` | yes | | `.env.local` |
| `SUPABASE_URL` | | yes | `worker/.env` |
| `SUPABASE_SECRET_KEY` | | yes | `worker/.env` |
| `WORKER_CONTACT` | | yes | `worker/.env` |
| `LL2_BASE` | | yes | `worker/.env` |
| `SOURCES_ENABLED` | | optional | `worker/.env` |
| `LOG_LEVEL` | | optional | `worker/.env` |

`.env.local` and `worker/.env` are in `.gitignore`. `.env.example` files list every name with no values.

## Supabase
1. Create a project in the region nearest to Chicago.
2. Apply `supabase/migrations/` through the Supabase MCP server or `supabase db push`.
3. Add Clerk as a third-party auth provider (`auth.md`).
4. Copy the publishable key to Vercel and the secret key to Railway.
5. Confirm the `pg_cron` jobs exist: `select jobname, schedule from cron.job;`.

Free-plan limits relevant to this project:

| Limit | Value |
|---|---|
| Realtime messages | 2,000,000 per month |
| Realtime concurrent connections | 200 |
| Realtime messages per second | 100 |
| Database size | 500 MB |
| Active projects | 2 |
| Inactivity pause | After 1 week without activity, with a warning email first |

The worker's writes keep the project active. Open the deployed page at least once a week until grades are returned. The Usage page shows Realtime messages; check it daily during testing.

## Railway
1. Verify the account through GitHub (`worker.md`).
2. Deploy the worker as described in `worker.md`.
3. Workspace settings → Usage: set a usage alert, and set a hard limit below the remaining trial credit.

The trial grants a one-time $5 credit valid for 30 days. A worker that sleeps between fetches uses a small fraction of that. Do not add a payment method; if the worker cannot reach its sources after verification, report it to the course staff before paying.

## Vercel
1. Import the GitHub repository. Framework preset: Next.js. Root directory: repository root.
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

## Open items
- Verify the Railway hard-limit setting is available on the trial plan before relying on it; set the usage alert in all cases.

## Sources
- Supabase, Pricing: https://supabase.com/pricing
- Supabase docs, Realtime Limits: https://supabase.com/docs/guides/realtime/limits
- Supabase docs, Free project pausing: https://supabase.com/docs/guides/platform/free-project-pausing
- Railway docs, Free Trial: https://docs.railway.com/pricing/free-trial
- Vercel docs, Plans: https://vercel.com/docs/plans
- Vercel docs, Limits: https://vercel.com/docs/limits
