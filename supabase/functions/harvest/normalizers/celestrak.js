import { NormalizeError, num, parseJson, requireKeys, skyObject, str } from './common.js';

const FIELDS = {
  name: ['OBJECT_NAME', str],
  objectId: ['OBJECT_ID', str],
  noradId: ['NORAD_CAT_ID', str],
  epoch: ['EPOCH', epoch],
  meanMotion: ['MEAN_MOTION', num],
  eccentricity: ['ECCENTRICITY', num],
  inclination: ['INCLINATION', num],
  raan: ['RA_OF_ASC_NODE', num],
  argPericenter: ['ARG_OF_PERICENTER', num],
  meanAnomaly: ['MEAN_ANOMALY', num],
  bstar: ['BSTAR', num],
  meanMotionDot: ['MEAN_MOTION_DOT', num],
  meanMotionDdot: ['MEAN_MOTION_DDOT', num],
  ephemerisType: ['EPHEMERIS_TYPE', num],
  classification: ['CLASSIFICATION_TYPE', str],
  elementSetNo: ['ELEMENT_SET_NO', num],
  revAtEpoch: ['REV_AT_EPOCH', num],
};
/** OMM EPOCH as ISO 8601 UTC, keeping its microseconds; CelesTrak omits the zone. */
function epoch(value) {
  const s = str(value);
  if (!s) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`;
  if (!Number.isFinite(Date.parse(iso))) throw new NormalizeError(`EPOCH ${JSON.stringify(s.slice(0, 40))} is not a timestamp`);
  return iso;
}
const REQUIRED = ['NORAD_CAT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY'];

/** CelesTrak GP OMM JSON: one object per catalog number. */
export function celestrakOmm(body, _args, ctx) {
  const doc = parseJson(body);
  if (!Array.isArray(doc) || doc.length === 0) throw new NormalizeError('CelesTrak body is not a non-empty JSON array');
  return doc.map((row, i) => {
    requireKeys(row, REQUIRED, `OMM record ${i}`);
    const fields = {};
    for (const [name, [key, conv]] of Object.entries(FIELDS)) fields[name] = conv(row[key]);
    if (!fields.noradId) throw new NormalizeError(`OMM record ${i} has an empty NORAD_CAT_ID`);
    return skyObject(ctx, fields.noradId, fields);
  });
}
