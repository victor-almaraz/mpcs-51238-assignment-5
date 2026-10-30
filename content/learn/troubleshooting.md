---
title: Troubleshooting
order: 10
---

# Troubleshooting

## No sound
| Check | Fix |
|---|---|
| The piece has not been started | Press **Run**. Browsers allow sound only after a click. |
| The script has errors | Open the **Problems** tab. A piece with errors does not run. |
| No group is followed | Add a `sky.group(...)` or `sky.swpc(...)` call. |
| The group is empty | Check the **Sky** panel. `jpl.scout` and `jpl.cad` can be empty for hours. |
| Every pitch is `null` | A field name is misspelled, or a value is absent. Check the **Console** for the object's fields. |
| A reaction muted the instrument | Check the status bar for stale or down sources and the piece's `onStale`/`onDown` calls. |
| Volume | Check `volume` on each instrument and the master level in Settings. |

## Sound but no change
Most groups change every few minutes to hours ([Sky data](sky-data)). Use **Replay** or test events ([Live data states](live-data-states)) to hear changes on demand, or follow `swpc.*` for change every minute.

## Problem codes
| Code | Meaning | Fix |
|---|---|---|
| `syntax_error` | The script is not valid TypeScript | Fix the line shown |
| `type_error` (warning) | The type checker found a mismatch, such as a misspelled option or field, or a text value where a number belongs | Read the message on the underlined code; the piece still runs |
| `runtime_error` | The script threw an error while running | Read the message; often a misspelled function name |
| `timeout` | The script ran longer than 1.5 s | Remove loops that do not end |
| `unknown_option` | An instrument or effect option does not exist | Check the parameter names in the [Reference](reference) |
| `not_numeric` | `follow` or `mod` on a parameter that takes a list or a choice | Use the constructor for `harmonics`; use `follow` with an index for choices |
| `not_modulatable` | `mod` on a choice parameter or `harmonics` | Use `follow` |
| `unknown_group` | The group name does not exist | Check [Sky data](sky-data) |
| `unknown_field` (warning) | No object in the group has this field | Check the field name |
| `granular_sample` | Granular `source: 'sample'` | Pieces cannot load audio files; use `saw`, `noise` or `chord` |
| `slot_reused` | One effect placed in two chains | Create a second effect |
| `lfo_rate_range` | An LFO `rate` expression does not end in `.map(...)` or `.clamp(...)` | End the expression with one of them |
| `audio_outside_layer` | `audio.*` used outside a layer property | Use audio signals in layers only |
| `fn_in_layer` | `fn()` in a layer property | Use built-in expression steps |
| `expr_too_deep` | An expression nests more than 32 levels | Simplify the expression |
| `orbit_no_elements` | `orbit` on a group without orbits, such as `swpc.*` or `jpl.*` | Use a `celestrak.*` group |
| `orbit_quantity` | Unknown orbit quantity | Use one listed under Orbits in the [Reference](reference) |
| `orbit_no_object` | `orbit(...)` outside a voice, trigger or layer | Use `sky.orbit(objectId, quantity)` |
| `limit_<item>` | A limit is exceeded, for example `limit_reverbs` | See Limits in the [Reference](reference) |
| `ir_too_large` | The compiled piece exceeds 256 KB | Use fewer layers or bindings |
| `local_only` (warning) | The piece uses `fn` or `layer.shader` | The piece runs in your editor and cannot be shared |

## Effect reset
"Effect *type* on *instrument* was reset and bypassed" means the effect produced an invalid signal and turned itself off. It returns on the next save or Run. If it repeats, lower `drive`, `feedback` or `resonance`.
