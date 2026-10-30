// Edge Function entry (Deno). Everything else in this directory is runtime-neutral JavaScript.
import { createClient } from 'npm:@supabase/supabase-js@2';
import sources from './sources.json' with { type: 'json' };
import { buildConfig } from './config.js';
import { createLogger } from './log.js';
import { tick } from './pipeline.js';
import { createStore } from './store.js';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

function tokenMatches(header: string | null, token: string): boolean {
  const expected = `Bearer ${token}`;
  if (header === null || header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

Deno.serve((req) => {
  const token = Deno.env.get('HARVEST_TOKEN');
  if (!token) return new Response('HARVEST_TOKEN is not set\n', { status: 500 });
  if (req.method !== 'POST' || !tokenMatches(req.headers.get('authorization'), token)) {
    return new Response('unauthorized\n', { status: 401 });
  }
  let config;
  try {
    config = buildConfig(Deno.env.toObject(), sources);
  } catch (err) {
    return new Response(`${(err as Error).message}\n`, { status: 500 });
  }
  const log = createLogger({ level: config.logLevel });
  const client = createClient(config.supabaseUrl, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const work = tick({
    registry: config.registry, isEnabled: config.isEnabled, store: createStore(client),
    fetch, userAgent: config.userAgent, log,
  }).catch((err) => log.error({ event: 'tick_failed', error: String(err?.message ?? err) }));
  EdgeRuntime.waitUntil(work);
  return new Response(null, { status: 202 });
});
