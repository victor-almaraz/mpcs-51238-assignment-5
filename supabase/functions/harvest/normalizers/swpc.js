import { NormalizeError, num, parseJson, requireKeys, skyObject, str, utc } from './common.js';

/** Planetary Kp, one-minute file: the row with the latest time_tag. */
export function swpcKp(body, _args, ctx) {
  const doc = parseJson(body);
  if (!Array.isArray(doc) || doc.length === 0) throw new NormalizeError('Kp body is not a non-empty array');
  let latest = null;
  for (const row of doc) {
    requireKeys(row, ['time_tag', 'kp_index', 'estimated_kp'], 'Kp row');
    if (latest === null || row.time_tag > latest.time_tag) latest = row;
  }
  return [skyObject(ctx, 'planetary', {
    kp: num(latest.kp_index),
    kpEstimated: num(latest.estimated_kp),
    timeTag: utc(latest.time_tag),
  })];
}

const KINDS = {
  wind: { speed: 'proton_speed', density: 'proton_density', temperature: 'proton_temperature' },
  mag: { bt: 'bt', bz: 'bz_gsm' },
};

/** RTSW one-minute files: the first (newest) row whose `active` is true. */
export function swpcRtsw(body, args, ctx) {
  const map = KINDS[args.kind];
  if (!map) throw new NormalizeError(`unknown RTSW kind ${args.kind}`);
  const doc = parseJson(body);
  if (!Array.isArray(doc)) throw new NormalizeError('RTSW body is not an array');
  const row = doc.find((r) => r && r.active === true);
  if (!row) throw new NormalizeError('RTSW body has no active row');
  requireKeys(row, ['time_tag', 'source', ...Object.values(map)], 'RTSW row');
  const fields = {};
  for (const [name, key] of Object.entries(map)) fields[name] = num(row[key]);
  fields.spacecraft = str(row.source);
  fields.timeTag = utc(row.time_tag);
  return [skyObject(ctx, 'l1', fields)];
}
