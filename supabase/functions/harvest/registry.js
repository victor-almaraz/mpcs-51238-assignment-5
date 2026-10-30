const POLICIES = ['halt', 'retryAfter', 'backoff'];
const KEYS = ['id', 'group', 'url', 'intervalSec', 'timeoutMs', 'normalizer', 'normalizerArgs', 'full', 'onNon200', 'maxBackoffSec', 'enabled'];

export class RegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegistryError';
  }
}

/**
 * Validate the registry and substitute `${NAME}` placeholders in URLs.
 * @param {unknown} entries parsed sources.json
 * @param {{ normalizers: Record<string, Function>, vars: Record<string, string | undefined> }} deps
 */
export function loadRegistry(entries, { normalizers, vars }) {
  if (!Array.isArray(entries)) throw new RegistryError('sources.json: top level must be an array');
  const seen = new Set();
  return entries.map((e, i) => {
    const where = `sources.json entry ${i}${e && typeof e.id === 'string' ? ` (${e.id})` : ''}`;
    const fail = (msg) => { throw new RegistryError(`${where}: ${msg}`); };
    if (!e || typeof e !== 'object' || Array.isArray(e)) fail('must be an object');
    for (const k of KEYS) if (!(k in e)) fail(`missing key ${k}`);
    for (const k of Object.keys(e)) if (!KEYS.includes(k)) fail(`unknown key ${k}`);
    if (typeof e.id !== 'string' || !/^[a-z0-9]+\.[a-z0-9.-]+$/.test(e.id)) fail('id must look like source.name');
    if (seen.has(e.id)) fail('duplicate id');
    seen.add(e.id);
    if (typeof e.group !== 'string' || e.group === '') fail('group must be a non-empty string');
    if (!Number.isInteger(e.intervalSec) || e.intervalSec < 60) fail('intervalSec must be an integer >= 60');
    if (!Number.isInteger(e.timeoutMs) || e.timeoutMs < 1000 || e.timeoutMs > 60000) fail('timeoutMs must be an integer in 1000..60000');
    if (!Object.hasOwn(normalizers, e.normalizer)) fail(`unknown normalizer ${e.normalizer}`);
    if (!e.normalizerArgs || typeof e.normalizerArgs !== 'object' || Array.isArray(e.normalizerArgs)) fail('normalizerArgs must be an object');
    if (typeof e.full !== 'boolean') fail('full must be a boolean');
    if (!POLICIES.includes(e.onNon200)) fail(`onNon200 must be one of ${POLICIES.join(', ')}`);
    if (!Number.isInteger(e.maxBackoffSec) || e.maxBackoffSec < 0) fail('maxBackoffSec must be a non-negative integer');
    if (typeof e.enabled !== 'boolean') fail('enabled must be a boolean');
    const url = String(e.url).replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
      const v = vars[name];
      if (!v) fail(`url needs ${name}, which is not set`);
      return v.replace(/\/+$/, '');
    });
    let parsed;
    try { parsed = new URL(url); } catch { fail(`url is not a valid URL: ${url}`); }
    if (parsed.protocol !== 'https:') fail('url must use https');
    return { ...e, url, host: parsed.host };
  });
}

/** `SOURCES_ENABLED` patterns: comma-separated ids, `*` matches any run of characters. */
export function enabledMatcher(spec) {
  if (!spec || spec.trim() === '') return () => true;
  const res = spec.split(',').map((p) => p.trim()).filter(Boolean)
    .map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
  return (id) => res.some((re) => re.test(id));
}
