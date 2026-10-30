// src/lib/supabase-browser.ts
import { createClient } from '@supabase/supabase-js';

export function browserClient(getToken: () => Promise<string | null>) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { accessToken: async () => (await getToken()) ?? null },
  );
}
