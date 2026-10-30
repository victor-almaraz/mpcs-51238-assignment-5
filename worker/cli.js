// Local commands against the live project (doc/worker.md, Local run).
//   node --env-file=.env cli.js tick
//   node --env-file=.env cli.js --once <id>
//   node --env-file=.env cli.js clear-halt <id>
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { buildConfig } from '../supabase/functions/harvest/config.js';
import { createLogger } from '../supabase/functions/harvest/log.js';
import { runSource, tick } from '../supabase/functions/harvest/pipeline.js';
import { createStore } from '../supabase/functions/harvest/store.js';

const USAGE = 'usage: cli.js tick | --once <id> | clear-halt <id>';

function fail(message) {
  console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', event: 'cli', error: message }));
  process.exit(1);
}

const [cmd, id] = process.argv.slice(2);
if (!cmd || (cmd !== 'tick' && !id)) fail(USAGE);

let config;
try {
  const sources = JSON.parse(readFileSync(new URL('../supabase/functions/harvest/sources.json', import.meta.url), 'utf8'));
  config = buildConfig(process.env, sources);
} catch (err) {
  fail(err.message);
}
const log = createLogger({ level: config.logLevel });
const client = createClient(config.supabaseUrl, config.secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
const store = createStore(client);
const deps = { registry: config.registry, isEnabled: config.isEnabled, store, fetch, userAgent: config.userAgent, log, now: Date.now };

if (cmd === 'tick') {
  await tick(deps);
} else if (cmd === '--once') {
  const entry = config.registry.find((e) => e.id === id) ?? fail(`unknown source ${id}`);
  const st = (await store.loadStatus()).get(id);
  if (st?.halted) fail(`${id} is halted; run clear-halt ${id} first`);
  if (!(await store.claim(id, entry.intervalSec, st?.last_attempt_at ?? null))) fail(`${id} was claimed by another run`);
  const { ok } = await runSource(entry, st, deps);
  if (!ok) process.exit(1);
} else if (cmd === 'clear-halt') {
  if (!config.registry.some((e) => e.id === id)) fail(`unknown source ${id}`);
  if (!(await store.clearHalt(id))) fail(`${id} has no source_status row`);
} else {
  fail(USAGE);
}
