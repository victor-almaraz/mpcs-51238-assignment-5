# Patch format

## Scope
The JSON patch schema, save/load, validation, migration and errors. Storage is **files only**: no localStorage, no sessionStorage, no server.

## Schema (version 1)
```json
{
  "version": 1,
  "app": "synth-rack",
  "widgets": [
    { "type": "subtractive", "muted": false, "solo": false, "volume": 0.8, "part": "all",
      "params": { "waveform": "sawtooth", "cutoff": 2000, "resonance": 1, "attack": 0.01, "release": 0.3 } },
    { "type": "additive", "muted": false, "solo": false, "volume": 0.6, "part": "t2c1", "partLabel": "Bass",
      "params": { "harmonics": [1, 0.5, 0.33, 0.25, 0.2, 0.17, 0.14, 0.12], "attack": 0.02, "release": 0.5 } }
  ]
}
```
- `part` is `"all"` or a part key `"t<track>c<channel>"` (see "Parts" in `midi-decoding.md`).
- `partLabel` (optional) is the part's label at save time. The UI uses it to explain a fallback ("Part 'Bass' not in this file").
- `octave` (−3 to 3) and `cents` (−100 to 100), optional: the widget's tuning (`layout-and-responsive.md` "Widget anatomy"). Written only when non-zero; missing means 0; out-of-range values are clamped with an "Octave adjusted" or "Cents adjusted" warning.
- `locked` (optional): `true` for a locked widget. Written only when set; any other value means unlocked. Collapse is session state and is not stored.
- Live-input arming is session state and is not stored (`live-input.md`).
- `sampleName` (optional, granular only) is the name of the widget's user sample at save time. The audio itself is never stored: patches stay small text files, and samples are user files. Loading a patch whose granular source is `"sample"` adds the warning "Widget N: file 'name' is not stored in patches; load it again", and the widget is silent until a file is loaded (`synthesis-granular.md` "User sample").
- A patch may omit any param. A missing param takes its default (`synthesis-conventions.md`) and produces no "adjusted" warning.
- Param names and ranges come from the single `PARAM_DEFS` table (`synthesis-conventions.md`). Never duplicate the ranges.

## Validation (untrusted input)
```ts
const MAX_BYTES = 256 * 1024, MAX_WIDGETS = 24;   // project limits
function parsePatch(text: string, song: Song | null): { widgets: WidgetState[]; warnings: string[] } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new PatchError('Not valid JSON'); }
  if (!isObject(raw) || typeof raw.version !== 'number') throw new PatchError('Missing version');
  raw = migrate(raw);                                     // throws if version > CURRENT
  if (!Array.isArray(raw.widgets)) throw new PatchError('Missing widgets');
  const warnings: string[] = [];
  const widgets = raw.widgets.slice(0, MAX_WIDGETS).flatMap((w, i) => {
    if (!isObject(w) || !(w.type in PARAM_DEFS)) { warnings.push(`Widget ${i + 1}: unknown type, skipped`); return []; }
    const defs = PARAM_DEFS[w.type];
    const params = Object.fromEntries(defs.map(d => [d.name, coerce(d, (w.params as any)?.[d.name])])); // unknown keys dropped
    return [{ type: w.type, muted: w.muted === true, solo: w.solo === true,
              volume: clampNum(w.volume, 0, 1, 0.8), part: resolvePart(w.part, song, warnings), params }];
  });
  return { widgets, warnings };
}
```
- `coerce(def, v)`:
  - Numbers: `Number.isFinite(v) ? clamp(v, min, max) : default`.
  - Enums: the value if it is in `options`, else the default.
  - Arrays (harmonics): exactly 8 finite numbers, each clamped to [0, 1]. Pad or truncate to 8.
- Build objects from the whitelist only. Never spread or `Object.assign` parsed objects; this blocks `__proto__` keys and other prototype tricks.
- Reject the file before reading it if `file.size > MAX_BYTES`.
- Never insert strings as HTML. React escapes text content; never use `dangerouslySetInnerHTML`.

## Part fallback
- `resolvePart`:
  - A value that isn't `"all"` or a string matching `/^t\d{1,3}c\d{1,2}$/` becomes `"all"`, with a warning.
  - If `song` is null, or the key isn't in `song.parts`, return `"all"` and add a warning.
  - When a MIDI file is loaded *after* a patch, re-run `resolvePart` on every widget.
- The original key is kept in memory as `requestedPart`. Loading a matching MIDI file later in the session restores the assignment.

## Versioning and migration
- `CURRENT_VERSION = 1`. `migrate` applies the steps `v1 → v2 → …` in order. Each step is a pure function with its own test.
- A version greater than `CURRENT_VERSION` raises the error "Made with a newer version".
- Bump the version whenever a param is renamed, removed, or changes unit or scale. Adding a param needs no bump when its default leaves the sound of existing patches unchanged.

## Save
```ts
function savePatch(state: RackState) {
  const json = JSON.stringify(serialize(state), null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'synth-rack-patch.json' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
```
- Disable Save when the rack has no widgets.
- Success shows "Download started". The browser does not report download completion.

## Load
- Flow: `<input type="file" accept=".json,application/json">`, then `file.text()`, then `parsePatch`.
- No confirmation (GNOME HIG: undo over confirm). If the rack was not empty, the "Patch loaded" toast offers Undo while it is visible. Undo puts the replaced widgets back unchanged through the same patch-load ramp and shows "Previous rack restored".
- Apply: `releaseAll()`, then the patch-load ramp in `audio-safety.md` (outputs to 0, rebuild widgets, ramp back). Loading never starts notes.
- Reset `input.value = ''` after each load, so choosing the same file again still fires `change`.
- States:
  - Error: "Couldn't load patch: <reason>". The existing rack is untouched.
  - Success with warnings: "Patch loaded (2 settings adjusted)", with a details disclosure.

## Sources
- MDN, Blob, URL.createObjectURL, HTMLAnchorElement.download, File.text() (https://developer.mozilla.org/)
- MDN, `<input type="file">` (https://developer.mozilla.org/en-US/docs/Web/HTML/Element/input/file)
