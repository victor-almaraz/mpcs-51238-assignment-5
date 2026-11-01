import { isLogLevel } from './log.js';
import { normalizers } from './normalizers/index.js';
import { enabledMatcher, loadRegistry, RegistryError } from './registry.js';

const VERSION = '0.1.0';

/** Secret key: `SUPABASE_SECRET_KEY` (local) or the `default` entry of injected `SUPABASE_SECRET_KEYS`. */
export function secretKeyFrom(env) {
  if (env.SUPABASE_SECRET_KEY) return env.SUPABASE_SECRET_KEY;
  if (env.SUPABASE_SECRET_KEYS) {
    let keys;
    try {
      keys = JSON.parse(env.SUPABASE_SECRET_KEYS);
    } catch (err) {
      throw new RegistryError(`SUPABASE_SECRET_KEYS is not valid JSON: ${/** @type {Error} */ (err).message}`);
    }
    if (typeof keys?.default === 'string' && keys.default) return keys.default;
  }
  return null;
}

/**
 * Build the worker configuration from environment variables and the parsed registry.
 * Throws RegistryError naming the first problem.
 */
export function buildConfig(env, sources) {
  const missing = ['SUPABASE_URL', 'WORKER_CONTACT', 'LL2_BASE'].filter((k) => !env[k]);
  const secretKey = secretKeyFrom(env);
  if (!secretKey) missing.push('SUPABASE_SECRET_KEY or SUPABASE_SECRET_KEYS.default');
  if (missing.length) throw new RegistryError(`missing environment variable: ${missing.join(', ')}`);
  if (!/^[\x20-\x7e]+$/.test(env.WORKER_CONTACT) || /[()]/.test(env.WORKER_CONTACT)) {
    throw new RegistryError('WORKER_CONTACT must be printable ASCII without parentheses');
  }
  const logLevel = env.LOG_LEVEL || 'warn';
  if (!isLogLevel(logLevel)) throw new RegistryError(`LOG_LEVEL must be debug, info, warn or error, not ${logLevel}`);
  const registry = loadRegistry(sources, { normalizers, vars: { LL2_BASE: env.LL2_BASE } });
  return {
    supabaseUrl: env.SUPABASE_URL,
    secretKey,
    logLevel,
    userAgent: `Sphaerenmusik/${VERSION} (${env.WORKER_CONTACT})`,
    registry,
    isEnabled: enabledMatcher(env.SOURCES_ENABLED, registry.map((e) => e.id)),
  };
}
