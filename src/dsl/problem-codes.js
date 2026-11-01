// Single list of problem codes (doc/piece-dsl.md, Problem codes).
// content/learn/troubleshooting.md documents every code with `userFacing: true`;
// tests/dsl-codes.test.js checks that both lists match.

/** @typedef {'error' | 'warning'} Severity */
/** @typedef {{ severity: Severity, userFacing: boolean, condition: string }} CodeDef */

/** Items of the `limit_<item>` family. */
export const LIMIT_ITEMS = Object.freeze([
  'instruments', 'bindings', 'voices', 'slots', 'reverbs', 'lfos', 'retrigger_lfos',
  'routes', 'routes_per_target', 'layers', 'orbit_sources', 'handlers', 'source',
]);

/** @type {Readonly<Record<string, CodeDef>>} */
export const PROBLEM_CODES = Object.freeze({
  syntax_error: { severity: 'error', userFacing: true, condition: 'The script does not parse as TypeScript' },
  runtime_error: { severity: 'error', userFacing: true, condition: 'The script throws while running' },
  timeout: { severity: 'error', userFacing: true, condition: 'No result within 1500 ms' },
  unknown_option: { severity: 'error', userFacing: true, condition: 'An option name is not a parameter of the instrument, effect or layer type' },
  not_numeric: { severity: 'error', userFacing: true, condition: '`follow` on an array parameter where a number is required' },
  not_modulatable: { severity: 'error', userFacing: true, condition: '`mod` on an enum, array or `mod: null` parameter' },
  unknown_group: { severity: 'error', userFacing: true, condition: 'A group key is not in `groups.json`' },
  unknown_field: { severity: 'warning', userFacing: true, condition: "No object of the group's last snapshot has the field" },
  granular_sample: { severity: 'error', userFacing: true, condition: "Granular `source: 'sample'`" },
  slot_reused: { severity: 'error', userFacing: true, condition: 'One effect slot in two chains' },
  slot_unplaced: { severity: 'error', userFacing: true, condition: 'An effect slot with `follow` or `mod` is in no chain' },
  lfo_rate_range: { severity: 'error', userFacing: true, condition: 'An expression LFO rate does not end in `map` or `clamp`, or its range is empty' },
  audio_outside_layer: { severity: 'error', userFacing: true, condition: 'An `audio.*` op outside layer properties' },
  fn_in_layer: { severity: 'error', userFacing: true, condition: '`fn` in a layer property' },
  expr_too_deep: { severity: 'error', userFacing: true, condition: 'Expression depth above 32' },
  orbit_no_elements: { severity: 'error', userFacing: true, condition: '`orbit` or `sky.orbit` on a group or object without orbital elements' },
  orbit_quantity: { severity: 'error', userFacing: true, condition: 'Unknown orbit quantity' },
  orbit_no_object: { severity: 'error', userFacing: true, condition: '`orbit(...)` where no current object exists' },
  io_outside_handler: { severity: 'error', userFacing: true, condition: 'Setup calls an output method or `read.*`, which work only inside handlers' },
  handler_error: { severity: 'error', userFacing: true, condition: 'A handler threw while the piece played' },
  handler_timeout: { severity: 'error', userFacing: true, condition: 'One batch of handler calls ran longer than 250 ms' },
  ...Object.fromEntries(LIMIT_ITEMS.map((item) => [
    `limit_${item}`,
    { severity: 'error', userFacing: true, condition: `The ${item.replaceAll('_', ' ')} limit is exceeded` },
  ])),
  ir_too_large: { severity: 'error', userFacing: true, condition: 'Serialized IR above 256 KB' },
  ir_version_unsupported: { severity: 'error', userFacing: true, condition: '`irVersion` above the current version' },
  ir_schema: { severity: 'error', userFacing: false, condition: 'The IR does not match the schema, a vocabulary or a range' },
  ir_reference: { severity: 'error', userFacing: false, condition: 'The IR references an id that does not exist' },
  local_only: { severity: 'warning', userFacing: true, condition: 'The piece uses `fn` or `layer.shader`' },
  type_error: { severity: 'warning', userFacing: true, condition: 'The type checker reports an error' },
});

/**
 * User-facing codes as the guide lists them: the `limit_*` family collapses to `limit_<item>`.
 * @returns {string[]}
 */
export function userFacingCodes() {
  const out = new Set();
  for (const [code, def] of Object.entries(PROBLEM_CODES)) {
    if (!def.userFacing) continue;
    out.add(code.startsWith('limit_') ? 'limit_<item>' : code);
  }
  return [...out];
}

/**
 * @typedef {{ severity: Severity, code: string, path: string, line: number | null, message: string }} Problem
 */

/**
 * Builds a problem with the severity of its code.
 * @param {string} code
 * @param {string} path JSON Pointer into the IR, '' for the whole document
 * @param {string} message
 * @param {number | null} [line]
 * @returns {Problem}
 */
export function problem(code, path, message, line = null) {
  const def = PROBLEM_CODES[code];
  if (!def) throw new Error(`unknown problem code ${code}`);
  return { severity: def.severity, code, path, line, message };
}
