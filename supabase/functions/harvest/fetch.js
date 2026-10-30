/**
 * One HTTP GET. Never throws: network errors and timeouts return status 0.
 * @returns {Promise<{ status: number, body: string, retryAfterSec: number | null, error: string | null }>}
 */
export async function fetchSource(url, { fetch, userAgent, timeoutMs }) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json, text/plain;q=0.5' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    return { status: res.status, body, retryAfterSec: parseRetryAfter(res.headers.get('retry-after')), error: null };
  } catch (err) {
    const name = err?.name === 'TimeoutError' ? 'timeout' : 'network';
    return { status: 0, body: '', retryAfterSec: null, error: `${name}: ${err?.message ?? err}` };
  }
}

/** Retry-After as seconds; accepts delta-seconds or an HTTP date. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}
