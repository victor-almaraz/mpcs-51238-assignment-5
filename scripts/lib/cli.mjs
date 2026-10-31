// Shared command-line handling for the build scripts: strict flags, JSON-line diagnostics on
// stderr, and writing or checking generated files.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** Writes one JSON-line error to stderr and exits. @param {string} event @param {string} message @param {number} [code] */
export function fail(event, message, code = 1) {
  process.stderr.write(`${JSON.stringify({ level: 'error', event, message })}\n`);
  process.exit(code);
}

/**
 * Parses `argv` against `flags` (name → 'boolean' | 'list'). `--help` or `-h` prints `usage` to
 * stdout and exits 0; an unknown argument or a flag without its value exits 2.
 * @param {string[]} argv @param {Record<string, 'boolean' | 'list'>} flags @param {string} usage @param {string} event
 * @returns {Record<string, any>}
 */
export function parseArgs(argv, flags, usage, event) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [name, kind] of Object.entries(flags)) out[name] = kind === 'list' ? [] : false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { process.stdout.write(`${usage}\n`); process.exit(0); }
    const name = a.startsWith('--') ? a.slice(2) : '';
    if (!Object.hasOwn(flags, name)) fail(event, `unknown argument ${a}; usage: ${usage}`, 2);
    if (flags[name] === 'boolean') { out[name] = true; continue; }
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) fail(event, `${a} needs a value; usage: ${usage}`, 2);
    out[name].push(v);
  }
  return out;
}

/**
 * Writes `text` to `file`, or with `check` compares it. @returns {boolean} false when a check finds the file out of date
 * @param {string} file @param {string} text @param {boolean} check
 */
export function writeOrCheck(file, text, check) {
  if (!check) { writeFileSync(file, text); return true; }
  return existsSync(file) && readFileSync(file, 'utf8') === text;
}
