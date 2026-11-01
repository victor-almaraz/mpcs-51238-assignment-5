# Auth

## Scope
Clerk sign-in, Clerk as a Supabase third-party auth provider, the Supabase clients, Realtime authentication and key handling.

## Model
- Clerk issues session tokens. Supabase verifies them against Clerk's published keys; no secret is shared between the services.
- A Clerk session token carries `"role": "authenticated"` once the Clerk Supabase integration is active. Postgres runs the request as `authenticated`, and `auth.jwt() ->> 'sub'` is the Clerk user id.
- A request without a token runs as `anon`. Public sky data is readable as `anon` (`database.md`).

## Clerk setup
1. Install `@clerk/nextjs`. Wrap the root layout in `<ClerkProvider>`.
2. Create `proxy.ts` at the project root exporting `clerkMiddleware()` with `{ signInUrl: '/sign-in', signUpUrl: '/sign-up' }`, and pass the same URLs to `<ClerkProvider>`, so protected routes redirect to the app's own sign-in page rather than the Clerk-hosted one. In Next.js 16, `proxy.ts` replaces `middleware.ts`.
3. Public routes: `/`, `/listen`, `/console`, `/learn(.*)`, `/try`, `/sign-in(.*)`, `/sign-up(.*)`, `/dsl-sandbox.js`. All other routes call `auth.protect()`. The `matcher` in `proxy.ts` skips `_next`, `worklets` and static files by extension (`.css`, `.js`, `.json`, `.map`, `.png`, `.svg`, `.ico`, `.woff`, `.woff2`, `.txt`, `.wasm`).
4. Server components check `auth()` again (`/projects`, `/settings`, the project loader in `src/ui/load-project.server.ts`). `proxy.ts` is a routing layer, not the security boundary; RLS is.

## Clerk–Supabase integration
1. Clerk Dashboard → Integrations → Supabase → Activate. Copy the Clerk domain.
2. Supabase Dashboard → Authentication → Sign In / Providers → Third-Party Auth → Add provider → Clerk. Paste the domain.
3. For a local Supabase CLI instance (optional), add to `supabase/config.toml`:
   ```toml
   [auth.third_party.clerk]
   enabled = true
   domain = "example.clerk.accounts.dev"
   ```
4. Do not create a Clerk JWT template named `supabase`. That method is deprecated and requires sharing the Supabase JWT secret.

## Clients
```ts
// src/lib/supabase-browser.ts
import { createClient } from '@supabase/supabase-js';

export function browserClient(getToken: () => Promise<string | null>) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { accessToken: async () => (await getToken()) ?? null },
  );
}
```
```ts
// src/lib/supabase-server.ts
import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { auth } from '@clerk/nextjs/server';

export function serverClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { accessToken: async () => (await auth()).getToken() },
  );
}
```
- `SupabaseProvider` in `src/ui/app-providers.tsx` creates one browser client per tab for client components. Its token function returns `useAuth().getToken()` while the visitor is signed in and `null` otherwise.
- The landing page's live snapshot (`app/_landing/live-snapshot.tsx`) creates its own client with a token function that returns `null`, and reads by REST only.
- With `accessToken` set, `supabase-js` sends the Clerk token on REST requests and on the Realtime socket. These clients never call `supabase.auth.*`.
- The worker uses its own client created with the secret key: the `default` entry of `SUPABASE_SECRET_KEYS` in the Edge Function, `SUPABASE_SECRET_KEY` in local runs (`worker.md`).

## Realtime authentication
- One client shares one WebSocket for all channels in a tab.
- Realtime caches RLS decisions per connection and re-evaluates them when the client sends a refreshed token. `supabase-js` calls `accessToken` again before expiry.
- On `CHANNEL_ERROR`, `TIMED_OUT` or `CLOSED`, the sky store calls `supabase.realtime.setAuth()` and resubscribes with exponential backoff (1 s to 30 s).
- Check the setup while signed in: `/projects` lists the account's projects. RLS returns `projects` rows only to `authenticated` requests whose `sub` equals `user_id`, and `anon` holds no grant on `projects`, so a token that Supabase rejects or that lacks `"role": "authenticated"` makes the list fail to load.

## Keys
| Key | Format | Location | Behavior |
|---|---|---|---|
| Publishable | `sb_publishable_...` | Browser; Vercel `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Subject to RLS |
| Secret | `sb_secret_...` | Edge Function (injected `SUPABASE_SECRET_KEYS`) and `worker/.env` only | Bypasses RLS; rejected when sent from a browser |
| Clerk publishable | `pk_...` | Vercel `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Public |
| Clerk secret | `sk_...` | Vercel `CLERK_SECRET_KEY` | Server only |

The legacy `anon` and `service_role` keys are not used. Supabase deprecates them by the end of 2026.

## Sources
- Supabase docs, Third-party auth: Clerk: https://supabase.com/docs/guides/auth/third-party/clerk
- Clerk docs, Integrate Supabase with Clerk: https://clerk.com/docs/guides/development/integrations/databases/supabase
- Supabase docs, API keys: https://supabase.com/docs/guides/getting-started/api-keys
- Supabase docs, Realtime Authorization: https://supabase.com/docs/guides/realtime/authorization
- Next.js docs, Upgrading to version 16: https://nextjs.org/docs/app/guides/upgrading/version-16
