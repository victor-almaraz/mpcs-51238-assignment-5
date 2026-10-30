import { NormalizeError, num, parseJson, requireKeys, skyObject, str } from './common.js';

/** Launch Library 2 upcoming launches, mode=normal. */
export function ll2Launches(body, _args, ctx) {
  const doc = parseJson(body);
  if (!Array.isArray(doc?.results)) throw new NormalizeError('LL2 body lacks results');
  return doc.results.map((r, i) => {
    requireKeys(r, ['id', 'name', 'net', 'status', 'launch_service_provider', 'pad'], `LL2 launch ${i}`);
    return skyObject(ctx, r.id, {
      name: str(r.name),
      net: str(r.net),
      status: str(r.status?.abbrev),
      provider: str(r.launch_service_provider?.name),
      padLat: num(r.pad?.latitude),
      padLon: num(r.pad?.longitude),
    });
  });
}
