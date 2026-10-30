import { NormalizeError, checkVersion, num, parseJson, requireKeys, skyObject, str } from './common.js';

const AU_IN_LD = 389.17;
const CAD_FIELDS = ['des', 'cd', 'dist', 'v_rel', 'v_inf', 'h'];

/** SBDB Close Approach Data: `fields` names the columns of each `data` row. */
export function jplCad(body, args, ctx) {
  const doc = parseJson(body);
  checkVersion(doc, args.version, ctx);
  if (Number(doc.count) === 0) return [];
  if (!Array.isArray(doc.fields) || !Array.isArray(doc.data)) throw new NormalizeError('CAD body lacks fields or data');
  for (const f of CAD_FIELDS) if (!doc.fields.includes(f)) throw new NormalizeError(`CAD fields lack ${f}`);
  return doc.data.map((values) => {
    const r = Object.fromEntries(doc.fields.map((f, i) => [f, values[i]]));
    const distAu = num(r.dist);
    return skyObject(ctx, `${r.des}|${r.cd}`, {
      des: str(r.des),
      closeApproach: str(r.cd),
      distAu,
      distLD: distAu === null ? null : distAu * AU_IN_LD,
      vRel: num(r.v_rel),
      vInf: num(r.v_inf),
      h: num(r.h),
    });
  });
}

const SCOUT_FIELDS = ['objectName', 'neoScore', 'phaScore', 'nObs', 'arc', 'H', 'vInf', 'rating', 'lastRun'];

/** Scout: one object per candidate designation. */
export function jplScout(body, args, ctx) {
  const doc = parseJson(body);
  checkVersion(doc, args.version, ctx);
  if (!Array.isArray(doc.data)) throw new NormalizeError('Scout body lacks data');
  return doc.data.map((r, i) => {
    requireKeys(r, SCOUT_FIELDS, `Scout candidate ${i}`);
    return skyObject(ctx, r.objectName, {
      objectName: str(r.objectName),
      neoScore: num(r.neoScore),
      phaScore: num(r.phaScore),
      nObs: num(r.nObs),
      arc: num(r.arc),
      h: num(r.H),
      vInf: num(r.vInf),
      rating: num(r.rating),
      lastRun: str(r.lastRun),
    });
  });
}
