// Local commands against the live project (doc/worker.md, Local run).
//   node --env-file=.env cli.js tick
//   node --env-file=.env cli.js --once <id>
//   node --env-file=.env cli.js clear-halt <id>
//   node cli.js help
// Exit status: 0 when every run succeeded, 1 when a run failed or a command could not run, 2 on a usage error.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { buildConfig } from '../supabase/functions/harvest/config.js';
import { createLogger } from '../supabase/functions/harvest/log.js';
import { runOnce, tick } from '../supabase/functions/harvest/pipeline.js';
import { createStore } from '../supabase/functions/harvest/store.js';

const USAGE = 'usage: cli.js tick | --once <id> | clear-halt <id> | help';

function fail(message, code = 1) {
  console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', event: 'cli', error: message }));
  process.exit(code);
}

const args = process.argv.slice(2);
const [cmd, id] = args;
if (cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(USAGE); process.exit(0); }
const arity = { tick: 1, '--once': 2, 'clear-halt': 2 }[cmd];
if (arity === undefined || args.length !== arity) fail(USAGE, 2);

let config;
try {
  const sources = JSON.parse(readFileSync(new URL('../supabase/functions/harvest/sources.json', import.meta.url), 'utf8'));
  config = buildConfig(process.env, sources);
} catch (err) {
  fail(err.message);
}
async function main() {
  const log = createLogger({ level: config.logLevel });
  const client = createClient(config.supabaseUrl, config.secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const store = createStore(client);
  const deps = { registry: config.registry, isEnabled: config.isEnabled, store, fetch, userAgent: config.userAgent, log, now: Date.now };
  if (cmd === 'tick') {
    const { failed } = await tick(deps);
    if (failed.length) process.exit(1);
  } else if (cmd === '--once') {
    const entry = config.registry.find((e) => e.id === id) ?? fail(`unknown source ${id}`);
    const { result, ok } = await runOnce(entry, deps);
    if (result === 'halted') fail(`${id} is halted; run clear-halt ${id} first`);
    if (result === 'host_busy') fail(`${id} was not run: another invocation holds the lease for ${entry.host}; try again shortly`);
    if (result === 'not_claimed') fail(`${id} was not claimed: another run holds it, it is halted, or it is within its interval`);
    if (!ok) process.exit(1);
  } else if (cmd === 'clear-halt') {
    if (!config.registry.some((e) => e.id === id)) fail(`unknown source ${id}`);
    if (!(await store.clearHalt(id))) fail(`${id} has no source_status row`);
  }
}

// Any rejection (for example an unreachable database) goes through the JSON-line fail path.
main().catch((err) => fail(String(err?.message ?? err)));
