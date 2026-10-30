// Restores CelesTrak OMM keys from normalized celestrak.* fields (doc/sources.md, CelesTrak).

export class OmmError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'OmmError';
  }
}

/** Field name → OMM key, in CelesTrak's key order. */
export const OMM_KEYS = {
  name: 'OBJECT_NAME',
  objectId: 'OBJECT_ID',
  epoch: 'EPOCH',
  meanMotion: 'MEAN_MOTION',
  eccentricity: 'ECCENTRICITY',
  inclination: 'INCLINATION',
  raan: 'RA_OF_ASC_NODE',
  argPericenter: 'ARG_OF_PERICENTER',
  meanAnomaly: 'MEAN_ANOMALY',
  ephemerisType: 'EPHEMERIS_TYPE',
  classification: 'CLASSIFICATION_TYPE',
  noradId: 'NORAD_CAT_ID',
  elementSetNo: 'ELEMENT_SET_NO',
  revAtEpoch: 'REV_AT_EPOCH',
  bstar: 'BSTAR',
  meanMotionDot: 'MEAN_MOTION_DOT',
  meanMotionDdot: 'MEAN_MOTION_DDOT',
};

/** Numeric elements json2satrec needs. */
const REQUIRED_NUMBERS = ['meanMotion', 'eccentricity', 'inclination', 'raan', 'argPericenter', 'meanAnomaly'];
/** Numeric terms that default to 0 when null. */
const ZERO_DEFAULT = ['bstar', 'meanMotionDot', 'meanMotionDdot'];

/**
 * OMM JSON object for `satellite.json2satrec`. Null optional fields are omitted;
 * null drag terms become 0. EPOCH loses the `Z` the normalizer appended.
 * @param {Record<string, number | string | boolean | null>} fields
 * @returns {Record<string, number | string>}
 * @throws {OmmError} when a required element is missing or invalid
 */
export function toOmm(fields) {
  if (fields === null || typeof fields !== 'object') throw new OmmError('OMM fields must be an object');
  for (const k of REQUIRED_NUMBERS) {
    if (typeof fields[k] !== 'number' || !Number.isFinite(fields[k])) {
      throw new OmmError(`OMM field ${k} must be a finite number, got ${JSON.stringify(fields[k])}`);
    }
  }
  if (typeof fields.epoch !== 'string' || !Number.isFinite(Date.parse(withZone(fields.epoch)))) {
    throw new OmmError(`OMM field epoch must be an ISO 8601 time, got ${JSON.stringify(fields.epoch)}`);
  }
  if (typeof fields.noradId !== 'string' || !/^\d+$/.test(fields.noradId)) {
    throw new OmmError(`OMM field noradId must be a decimal string, got ${JSON.stringify(fields.noradId)}`);
  }
  /** @type {Record<string, number | string>} */
  const omm = {};
  for (const [name, key] of Object.entries(OMM_KEYS)) {
    let v = fields[name];
    if (v === null || v === undefined) {
      if (ZERO_DEFAULT.includes(name)) v = 0;
      else if (name === 'elementSetNo') v = 999;
      else continue;
    }
    if (name === 'epoch') v = String(v).replace(/Z$/, '');
    omm[key] = /** @type {number | string} */ (v);
  }
  if (!('OBJECT_NAME' in omm)) omm.OBJECT_NAME = '';
  if (!('OBJECT_ID' in omm)) omm.OBJECT_ID = '';
  return omm;
}

/** @param {string} s */
function withZone(s) {
  return /[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`;
}
