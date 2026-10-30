export class NormalizeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NormalizeError';
  }
}

/** Parse a JSON body after stripping trailing NUL bytes. */
export function parseJson(body) {
  const text = body.replace(/\u0000+$/, '');
  try {
    return JSON.parse(text);
  } catch {
    throw new NormalizeError(`body is not JSON: ${JSON.stringify(text.slice(0, 80))}`);
  }
}

/** Finite number or null. Accepts numeric strings; maps the -9999 sentinel to null. */
export function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n === -9999) return null;
  return n;
}

export function str(value) {
  return value === null || value === undefined ? null : String(value);
}

/** ISO 8601 UTC; SWPC time tags carry no zone and are UTC. */
export function utc(value) {
  if (typeof value !== 'string' || value === '') return null;
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function requireKeys(row, keys, what) {
  for (const k of keys) {
    if (!(k in row)) throw new NormalizeError(`${what} lacks field ${k}`);
  }
}

/** Log a warning when signature.version differs from the expected one. */
export function checkVersion(doc, expected, ctx) {
  const got = doc?.signature?.version;
  if (got === undefined) throw new NormalizeError('response lacks signature.version');
  if (expected && got !== expected) ctx.warn({ event: 'version_mismatch', expected, got });
}

export function skyObject(ctx, key, fields) {
  return { id: `${ctx.group}:${key}`, source: ctx.source, group: ctx.group, fields };
}
