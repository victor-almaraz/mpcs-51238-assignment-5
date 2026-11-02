// Fallback completion until the type-check worker has loaded (doc/ui.md, Editor completion).
// Reads the normalized definition tables (PARAM_DEFS, the effect registry, layer-defs and
// groups.json through src/dsl/load-defs.js) and completes builder names, options, group keys
// and field names. Pure: the editor adapts the result to a CodeMirror CompletionSource.

export const BUILDER_NAMES = Object.freeze([
  'scale', 'seed', 'tempo', 'master', 'lfo', 'sky', 'field', 'num', 'rand', 'orbit', 'onStale', 'onDown',
  'view', 'layer', 'color', 'audio', 'fn',
  'on', 'every', 'after', 'onFreshness', 'follow', 'read', 'time', 'random', 'randInt', 'choose',
]);

export const MEMBERS = Object.freeze({
  sky: ['group', 'swpc', 'value', 'orbit'],
  view: ['projection', 'background'],
  audio: ['level', 'spectrum', 'voice'],
  read: ['swpc', 'group', 'object', 'freshness', 'orbit'],
});

export const ORBIT_QUANTITIES = Object.freeze(['latitude', 'phaseSin', 'phaseCos', 'altitude', 'longitude', 'sunlit', 'elevation']);
export const PROJECTIONS = Object.freeze(['orbital', 'map', 'sky']);

/**
 * @typedef {{ label: string, type: string, detail?: string }} Option
 * @typedef {{ from: number, options: Option[] }} Result  `from` is an offset into `text`
 */

/**
 * @param {string} text the document up to the cursor
 * @param {import('../dsl/defs.js').Defs} defs
 * @param {{ explicit?: boolean }} [opts]
 * @returns {Result | null}
 */
export function completeAt(text, defs, { explicit = false } = {}) {
  const line = text.slice(text.lastIndexOf('\n') + 1);
  const lineStart = text.length - line.length;

  // String argument: field('…'), sky.group('…'), orbit('…'), count('…'), view.projection('…').
  const str = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\(\s*(?:(?:[^()'"]|'[^']*'|"[^"]*")*,\s*)?(['"])([^'"]*)$/.exec(line);
  if (str) {
    const [, callee, , partial] = str;
    const from = text.length - partial.length;
    const opts = stringOptions(callee, line, defs, str.index);
    if (opts) return { from, options: opts };
  }

  // Member access: sky.gr|, layer.po|, view.|, audio.|
  const mem = /([A-Za-z_$][\w$]*)\.([\w$]*)$/.exec(line);
  if (mem) {
    const [, obj, partial] = mem;
    const from = text.length - partial.length;
    if (obj === 'layer') return { from, options: [...Object.keys(defs.layers), 'shader'].map((l) => ({ label: l, type: 'function', detail: 'layer' })) };
    if (Object.hasOwn(MEMBERS, obj)) return { from, options: MEMBERS[/** @type {keyof typeof MEMBERS} */ (obj)].map((m) => ({ label: m, type: 'function', detail: obj })) };
    return null;
  }

  // Option name inside an options object: additive({ vol|, reverb({ |, layer.points(g, { si| .
  const word = /([A-Za-z_$][\w$]*)?$/.exec(line);
  const partial = word?.[1] ?? '';
  const call = enclosingOptionsCall(text.slice(0, text.length - partial.length));
  if (call) {
    const opts = optionNames(call, defs);
    if (opts) return { from: text.length - partial.length, options: opts };
  }

  // Builder names at an identifier start.
  if (partial || explicit) {
    const before = line.slice(0, line.length - partial.length);
    if (/[\w$.'"]$/.test(before)) return null;
    const names = [...BUILDER_NAMES, ...Object.keys(defs.instruments), ...Object.keys(defs.effects)];
    return { from: lineStart + line.length - partial.length, options: names.map((n) => ({ label: n, type: 'function', detail: kindOf(n, defs) })) };
  }
  return null;
}

/** @param {string} n @param {any} defs */
function kindOf(n, defs) {
  if (Object.hasOwn(defs.instruments, n)) return 'instrument';
  if (Object.hasOwn(defs.effects, n)) return 'effect';
  return 'builder';
}

/**
 * @param {string} callee @param {string} line @param {any} defs @param {number} at index of the call in the line
 * @returns {Option[] | null}
 */
function stringOptions(callee, line, defs, at) {
  const groups = Object.keys(defs.groups);
  if (callee === 'sky.group' || callee === 'onStale' || callee === 'onDown') {
    return groups.map((g) => ({ label: g, type: 'constant', detail: defs.groups[g].source }));
  }
  if (['field', 'mean', 'spread', 'top'].includes(/** @type {string} */ (callee.split('.').pop()))) {
    const g = /sky\.group\(\s*['"]([^'"]+)['"]/.exec(line)?.[1];
    return fieldOptions(g && Object.hasOwn(defs.groups, g) ? [g] : groups, defs);
  }
  if (callee === 'orbit' || callee === 'sky.orbit') {
    if (callee === 'sky.orbit' && !line.slice(at).includes(',')) {
      return groups.filter((g) => defs.groups[g].orbit).map((g) => ({ label: `${g}:`, type: 'constant', detail: 'object id prefix' }));
    }
    return ORBIT_QUANTITIES.map((q) => ({ label: q, type: 'constant', detail: 'orbit quantity' }));
  }
  if (callee === 'view.projection') return PROJECTIONS.map((p) => ({ label: p, type: 'constant', detail: 'projection' }));
  if (callee === 'sky.swpc') {
    const out = [];
    for (const g of groups) {
      if (!g.startsWith('swpc.')) continue;
      for (const f of Object.keys(defs.groups[g].fields)) out.push({ label: `${g.slice(5)}.${f}`, type: 'constant', detail: defs.groups[g].fields[f].unit });
    }
    return out;
  }
  return null;
}

/** @param {string[]} groups @param {any} defs @returns {Option[]} */
function fieldOptions(groups, defs) {
  const seen = new Map();
  for (const g of groups) {
    for (const [name, f] of Object.entries(defs.groups[g]?.fields ?? {})) {
      if (!seen.has(name)) seen.set(name, { label: name, type: 'property', detail: [/** @type {any} */ (f).type, /** @type {any} */ (f).unit].filter(Boolean).join(' ') });
    }
  }
  return [...seen.values()];
}

/**
 * The callee of the innermost unclosed `{` that directly follows `name(` or `name(args, `.
 * @param {string} text
 * @returns {string | null}
 */
export function enclosingOptionsCall(text) {
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '}' || ch === ')' || ch === ']') depth++;
    else if (ch === '(' || ch === '[') { if (depth === 0) return null; depth--; }
    else if (ch === '{') {
      if (depth > 0) { depth--; continue; }
      const callee = calleeBefore(text.slice(0, i));
      if (!callee) return null;
      // Inside the object, only complete at a key position: after `{` or `,`.
      const inner = text.slice(i + 1);
      if (/:[^,]*$/.test(inner.replace(/\([^()]*\)/g, ''))) return null;
      return callee;
    }
  }
  return null;
}

/**
 * The callee when `before` ends inside a call's argument list: `name(` or `name(a, b(c), `.
 * @param {string} before
 * @returns {string | null}
 */
function calleeBefore(before) {
  let j = before.length - 1;
  while (j >= 0 && /\s/.test(before[j])) j--;
  if (j >= 0 && before[j] !== '(' && before[j] !== ',') return null;
  let depth = 0;
  let quote = '';
  for (; j >= 0; j--) {
    const ch = before[j];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === ')' || ch === ']' || ch === '}') depth++;
    else if (ch === '(' || ch === '[' || ch === '{') {
      if (depth === 0) {
        if (ch !== '(') return null;
        const m = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*$/.exec(before.slice(0, j));
        return m ? m[1] : null;
      }
      depth--;
    } else if (ch === ';' && depth === 0) return null;
  }
  return null;
}

/** @param {string} callee @param {any} defs @returns {Option[] | null} */
function optionNames(callee, defs) {
  if (Object.hasOwn(defs.instruments, callee)) {
    const spec = defs.instruments[callee];
    const tuning = ['volume', 'octave', 'cents'].map((k) => ({ label: k, type: 'property', detail: 'tuning' }));
    return [...tuning, ...spec.order.map((/** @type {string} */ p) => ({ label: p, type: 'property', detail: paramDetail(spec.params[p]) }))];
  }
  if (Object.hasOwn(defs.effects, callee)) {
    const spec = defs.effects[callee];
    return spec.order.map((/** @type {string} */ p) => ({ label: p, type: 'property', detail: paramDetail(spec.params[p]) }));
  }
  if (callee.startsWith('layer.')) {
    const type = callee.slice(6);
    const spec = defs.layers[type];
    if (!spec) return null;
    return spec.order.map((/** @type {string} */ p) => ({ label: p, type: 'property', detail: spec.props[p].type }));
  }
  if (callee.endsWith('.voices')) return ['pitch', 'velocity', 'pan', 'voiceMods'].map((l) => ({ label: l, type: 'property', detail: 'voices' }));
  if (callee.endsWith('.trigger')) return ['pitch', 'velocity', 'durationMs', 'maxPerSecond'].map((l) => ({ label: l, type: 'property', detail: 'trigger' }));
  return null;
}

/** @param {any} p */
function paramDetail(p) {
  if (!p) return '';
  if (p.kind === 'enum') return (p.options ?? []).join(' | ');
  if (p.kind === 'array') return `array[${p.length ?? ''}]`;
  return `${p.min}–${p.max}${p.unit ? ` ${p.unit}` : ''}`;
}
