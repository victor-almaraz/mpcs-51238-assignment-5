# Auth

## Scope
Clerk sign-in, Clerk as a Supabase third-party auth provider, the Supabase clients, Realtime authentication and key handling.

## Model
- Clerk issues session tokens. Supabase verifies them against Clerk's published keys; no secret is shared between the services.
- A Clerk session token carries `"role": "authenticated"` once the Clerk Supabase integration is active. Postgres runs the request as `authenticated`, and `auth.jwt() ->> 'sub'` is the Clerk user id.
- A request without a token runs as `anon`. Public sky data is readable as `anon` (`database.md`).

## Clerk setup
1. Install `@clerk/nextjs`. Wrap the root layout in `<ClerkProvider>`.
2. Create `proxy.ts` at the project root exporting `clerkMiddleware()`. In Next.js 16, `proxy.ts` replaces `middleware.ts`.
3. Public routes: `/`, `/listen`, `/console`, `/learn(.*)`, `/try`, `/sign-in(.*)`, `/sign-up(.*)`. All other routes call `auth.protect()`.
4. Server components and route handlers check `auth()` again. `proxy.ts` is a routing layer, not the security boundary; RLS is.

## Clerk–Supabase integration
1. Clerk Dashboard → Integrations → Supabase → Activate. Copy the Clerk domain.
2. Supabase Dashboard → Authentication → Sign In / Providers → Third-Party Auth → Add provider → Clerk. Paste the domain.
3. For the local Supabase CLI, add to `supabase/config.toml`:
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
- Client components create one browser client per tab, passing `useSession().session?.getToken`. Signed-out visitors pass a function returning `null`.
- With `accessToken` set, `supabase-js` sends the Clerk token on REST requests and on the Realtime socket. These clients never call `supabase.auth.*`.
- The worker uses its own client created with `SUPABASE_SECRET_KEY` (`worker.md`).

## Realtime authentication
- One client shares one WebSocket for all channels in a tab.
- Realtime caches RLS decisions per connection and re-evaluates them when the client sends a refreshed token. `supabase-js` calls `accessToken` again before expiry.
- On `CHANNEL_ERROR` or `TIMED_OUT`, the sky store calls `supabase.realtime.setAuth()` and resubscribes with exponential backoff (1 s to 30 s).
- Check the setup by running `select auth.jwt() ->> 'role'` through the browser client while signed in. The result is `authenticated`.

## Keys
| Key | Format | Location | Behavior |
|---|---|---|---|
| Publishable | `sb_publishable_...` | Browser; Vercel `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Subject to RLS |
| Secret | `sb_secret_...` | Railway `SUPABASE_SECRET_KEY` only | Bypasses RLS; rejected when sent from a browser |
| Clerk publishable | `pk_...` | Vercel `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Public |
| Clerk secret | `sk_...` | Vercel `CLERK_SECRET_KEY` | Server only |

The legacy `anon` and `service_role` keys are not used. Supabase deprecates them by the end of 2026.

## Sources
- Supabase docs, Third-party auth: Clerk: https://supabase.com/docs/guides/auth/third-party/clerk
- Clerk docs, Integrate Supabase with Clerk: https://clerk.com/docs/guides/development/integrations/databases/supabase
- Supabase docs, API keys: https://supabase.com/docs/guides/getting-started/api-keys
- Supabase docs, Realtime Authorization: https://supabase.com/docs/guides/realtime/authorization
- Next.js docs, Upgrading to version 16: https://nextjs.org/docs/app/guides/upgrading/version-16
