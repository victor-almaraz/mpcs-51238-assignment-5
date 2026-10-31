# UI

## Scope
Routes, screens and their states, IDE layout patterns, the status bar, command palette, keyboard shortcuts, editor completion and the settings schema.

## Style
- Minimal and IDE-derived: flat panels, 1 px dividers, no shadows, no rounded corners above 4 px.
- Type: system monospace for code, data, the console and the status bar; system sans-serif for chrome.
- Colour: tokens in `app/globals.css`, chosen in OKLCH so lightness and chroma are controlled per role.
  - Neutrals (`bg`, `panel`, `panel-2`, `line`, `fg`, `fg-muted`): one cool blue-grey hue (262°) at low chroma. Dark text is never pure white and the dark background is never pure black.
  - `accent`, a periwinkle analogous to the neutrals (268°), marks interaction only: the highlighted action, the selected tab and page, focus rings, links, check boxes and sliders.
  - Status hues are held at one lightness per theme: `ok` (green, 160°) for live state (fresh, playing, followed), `warn` (amber) for stale data, warnings and the Synthetic and Replay labels, `error` (red) for down sources and errors. Each state also has a text label and a distinct icon shape, so colour is never the only signal.
  - Syntax colours (`syn-keyword`, `syn-string`, `syn-number`, `syn-function`, `syn-type`) share one lightness and chroma per theme; comments use `fg-muted`, names and punctuation `fg`. One CodeMirror highlight style reads them in both themes.
  - Contrast: every text token is at least 4.5:1 (WCAG AA) on `bg`, `panel` and `panel-2` in its theme, and on black in the preview; text on the accent button is at least 4.5:1.
- Tokens are CSS variables in `app/globals.css` mapped through Tailwind v4 `@theme`.
- Type: Inter (variable, SIL OFL 1.1) for interface text; JetBrains Mono (variable, SIL OFL 1.1) for code, identifiers (group keys, file names), console records and numeric readouts. Both are bundled from `@fontsource-variable/*`, so pages make no font requests to third parties. Icons: Lucide (`lucide-react`, ISC), 16 px with a 2 px stroke; every icon-only control has a text label for assistive technology and a tooltip.
- Text follows the GNOME HIG writing rules: header capitalization (Title Case without small words) for buttons, tabs, menu and palette commands, dialog headings, section labels and table columns; sentence case for body text, descriptions, check box labels, tooltips and notices. Nothing is set in all capitals.
- Each view has at most one highlighted (accent) action; other buttons are bordered.
- Errors say what happened and what to do, in plain words; technical detail goes to the trace and the console.
- Narrow windows: below 768 px the editor stacks editor, preview and bottom panel vertically and hides the side panel; the console stacks its group list above the panels; the guide stacks its page list above the page. No page scrolls sideways at 360 px.
- Modal dialogs (the start notice, the command palette) keep Tab and Shift-Tab inside the dialog and return focus to the element that opened them when they close.
- The preview and run mode always use the dark tokens (`data-theme="dark"` on their root), because the picture is drawn on black; text on them keeps WCAG AA contrast in either theme.

## Routes
| Route | Access | Screen |
|---|---|---|
| `/` | Public | Landing page |
| `/sign-in`, `/sign-up` | Public | Sign-in and sign-up |
| `/listen` | Public | The `station-chord` starter in run mode, no account |
| `/projects` | Signed in | Projects list |
| `/projects/[id]` | Owner | Editor |
| `/projects/[id]/run` | Owner | Running project; `?kiosk=1` for installation mode |
| `/settings` | Signed in | User settings |
| `/console` | Public | Data console |
| `/learn`, `/learn/[slug]` | Public | User guide (`guide.md`) |
| `/try` | Public | Editor with an unsaved example from the guide (`guide.md`) |

## Landing (`/`)
Explains the idea behind the piece and leads to listening, composing and learning.

- Copy: `content/landing.md`, rendered at build time with the guide pipeline (`guide.md`, Rendering). The front matter holds `title` and `description` for page metadata. Each `##` heading opens one `<section>` labelled by that heading.
- Sections, in order:

| Section | Heading | Content | Visual |
|---|---|---|---|
| Hero | `# Sphärenmusik` | What the name means; one sentence on what the piece does | Live orbit map: `celestrak.stations` propagated in the page with `satellite.js` every 2 s and drawn on a 2D canvas in the `map` projection's equirectangular geometry, with a graticule, the night side shaded from the subsolar point, and 45-minute ground-track trails; the ISS is labelled. Elements come from the live strip's snapshot. Drawn once per snapshot with reduced motion |
| Actions | | Listen Now (`/listen`, the one highlighted action), Start Composing (`/sign-in`; Open Projects when signed in), Learn the Piece Script (`/learn`) | Buttons |
| Live strip | | Kp, solar wind speed, stations in orbit, next launch name and time, each with its freshness icon and label | Four tiles under the hero: label, monospace value, freshness icon |
| Spheres | The music of the spheres | Pythagorean ratios; Plato, Boethius and Kepler; the physics caveat | The four sources as a timeline (a list, one bold title per item); a string divided at 2:1, 3:2 and 4:3, drawn as SVG with a text alternative |
| Quadrivium | Four sister sciences | Plato's "sister sciences", Nicomachus's division, Boethius's term, the seven liberal arts | Plato's sentence as a pull quote; the division as a real 2 × 2 table styled as a grid, with the "In motion" column (music and astronomy) tinted |
| App | What Sphärenmusik does | The four arts in the app; four kinds of sky motion; the ISS twenty octaves up | The four kinds of motion as cards (a list, one bold title per item) |
| How | How it works | Four-step pipeline and the five-line script from `first-piece` | Numbered steps in two columns above the code block, highlighted with the editor's syntax colours; actions repeated, with Your First Piece (`/learn/first-piece`) in place of Learn |
| Honesty | What is real | Live data, composed mapping, no claim of sound in the sky | Set as a larger statement on a panel band |
| Reading | Further reading | Primary sources and one sourcebook | List |

- Layout: a sticky header with the app icon and name; a hero with a display-size heading, the lead paragraph, the actions and the orbit map, over a faint accent glow; then one band per section. On wide windows each section puts its heading in a narrow left column and its body on the right; below 1024 px they stack. Sections are separated by space, not rules. Headings come from the copy; the body renders without its heading so the page lays it out.
- The hero map does not use the WebGL renderer, so the landing page loads no shaders or Web Workers.
- Polling, propagation and drawing pause while the tab is hidden.
- The live strip reads `sky_objects` and `source_status` by REST through the publishable key on load and every 60 s; it opens no Realtime channel, so landing visitors use no Realtime messages. States: loading (`…` with "connecting"), fresh, stale and down as in States; a failed read shows "Live data unavailable" and keeps the rest of the page.
- The landing page starts no audio and creates no `AudioContext`. Sound starts only on `/listen` after a click.
- Visual safety applies (`visuals.md`): the orbit view has no flashes, honors reduced motion and pauses when the tab is hidden.
- Signed-in visitors see the same page with Open Projects in place of Start Composing; there is no redirect.
- States: the copy is static, so the page has no loading state apart from the live strip and the orbit view, which shows a static map until positions arrive.

## Sign-in (`/sign-in`)
- Single column: the name `Sphärenmusik`, Clerk `<SignIn />` (with a link to sign-up), a "Listen Without an Account" link to `/listen`, and a "Learn the Piece Script" link to `/learn`. When Clerk cannot load, a status message titled "Sign-In Unavailable" replaces the form and points to those links.
- Signed-in visitors are redirected to `/projects`.
- States: loading (Clerk component placeholder), error (Clerk inline error).

## Projects (`/projects`)
- Table with columns name, groups followed, last edited, last run. Row actions: Open, Run, Duplicate, Delete.
- Last edited is `projects.updated_at`; every save sets it. `projects` has no last-run column, so last run is recorded per browser in `localStorage` (`sphaerenmusik.lastRun.<id>`) when Run starts the project, and reads `—` on other devices.
- "New Project" offers Blank and each starter project as a template.
- On first sign-in the list contains the starter projects (Starter projects).
- Delete sets `deleted_at` and removes the row from the table with a toast "Project deleted" and an Undo button for 10 s. The `prune-projects` job deletes rows a day after `deleted_at`.
- States: loading (skeleton rows), empty ("No Projects" with New Project and the starter templates), error (message and Retry).

### Starter projects
Every account receives simple example projects on its first visit to `/projects`, so a first-time user can press Run and hear a piece without writing code.

- Source: `content/starters/manifest.json` lists each starter's `slug` and `name`; `content/starters/<slug>.ts` holds its script. Each script starts with comments that state what it plays and which guide pages explain it.
- Build: `scripts/build-starters.mjs` removes types with Sucrase, builds every starter with the builder and validator in Node, type-checks it against `builder.d.ts`, and writes `content/starters/<slug>.ir.json`. `npm run build` runs it first and fails on any error, warning or type diagnostic.
- Seeding: when `user_settings.starters_version` is below the manifest `version`, the `/projects` server component inserts each starter not yet present (matched by `projects.starter_slug`) with its `name`, `source`, `ir` and `project_subscriptions`, through the user's Clerk-authenticated client under RLS, then sets `starters_version`. The insert and update run in one RPC call, `seed_starters(p_version, p_projects)`, so a reload during seeding creates no duplicates.
- Starters are ordinary projects: the user can edit, rename or delete them. Deleted starters are not recreated, because `starters_version` is already current.
- A manifest `version` increase adds starters that an account does not have and leaves existing projects unchanged.

## Editor (`/projects/[id]`)
```
┌──┬───────────────┬────────────────────────────┬─────────────────────┐
│▣ │ EXPLORER      │ piece.ts                   │ PREVIEW    ▶ Run  ■ │
│⌕ │  piece.ts     │  1 scale('D', 'lydian');   │                     │
│◉ │ SKY           │  2                         │                     │
│⚙ │  ▸ celestrak  │  3 const stations = ...    │                     │
│  │  ▸ swpc       │                            │                     │
│  │  ▸ jpl        ├────────────────────────────┴─────────────────────┤
│  │  ▸ ll2        │ CONSOLE   PROBLEMS   IR   TRACE                  │
│  │               │ 14:02:11 CHANGE jpl.scout:P21kQ3x enter {...}    │
├──┴───────────────┴──────────────────────────────────────────────────┤
│ ✓ swpc  ✓ jpl  ◷ ll2  ⊗ celestrak │ ▷ playing  12/64 │ −18 dBFS │ Saved │
└─────────────────────────────────────────────────────────────────────┘
```
| Region | Content |
|---|---|
| Activity bar | Explorer, Search, Sky, Guide, Settings |
| Explorer | The project's `piece.ts` |
| Sky browser | Groups by source, followed groups marked, live sample values of each field. Clicking a field inserts `field('<name>')` at the cursor. |
| Editor | CodeMirror 6, TypeScript mode, with completion, hover types and inline problems from the type-check worker |
| Preview | Visual output at reduced resolution; transport Run and Stop |
| Bottom panel | Console, Problems, IR (read-only compiled JSON), Trace |
| Status bar | Per-source freshness, audio state, voices in use out of 64, output level, save state |

Behavior:
- Run is the user gesture that starts the AudioContext (`bindings.md`). Before the first Run, the preview shows "Press Run to start sound".
- Saving rebuilds the IR and hot-reloads the running piece (`piece-dsl.md`). A failed build focuses Problems and leaves the running piece unchanged.
- Autosave writes `source` and `ir` to `projects` 2 s after the last edit. Save state: `Saved`, `Saving…`, `Unsaved changes`, `Offline`.
- Hot reload never starts audio; only Run does.
- The preview toolbar holds Run, Stop, Panic, the master volume and the level meter with its Limit badge (`audio/audio-safety.md`, Safety UI). The master volume starts at `audio.masterDb` and cannot exceed `audio.maxMasterDb`.
- The sky store follows the groups of the last successful build; after a save they equal the project's `project_subscriptions`.
- Save writes `local_only = true` when the IR has `localOnly` (`piece-dsl.md`, Escape hatch).

### Status bar
| Item | Content |
|---|---|
| Freshness | One icon and label per registry id of the followed groups, or of every known source when no group is followed; the tooltip carries "stale since HH:MM" or "down since HH:MM" in `data.timeZone` |
| Audio | An icon and a word: `stopped` (square), `starting` (spinner), `playing` (play), `muted` after Panic (speaker off), `fault` after a safety fault (warning triangle) |
| Voices | Sounding voices out of 64 |
| Level | Post-limiter peak in dBFS, `−∞` when silent |
| Save | `Saved`, `Saving…`, `Unsaved changes`, `Offline`; `Scratch` in Try mode |

## Running (`/projects/[id]/run`)
- The preview fills the window. The cursor and the chrome (title, transport, links) start hidden and appear on pointer movement, a tap or a key press; they hide again after 3 s without any. They stay while the pointer is over the chrome, while focus is inside it (keyboard use, the start notice) and while the start notice is open. While hidden and stopped, the preview reads "Move the pointer or press a key to show the controls"; while shown and stopped, "Press Run to start sound".
- Overlays toggle independently: console (`C`), sounding voices (`N`), status bar (`S`).
- `Escape` returns to the editor, which stops the piece. Panic stays available as a button in the chrome.
- Installation mode (`?kiosk=1`): no cursor, no chrome, a single "Begin Listening" click starts audio (the button carries the volume and photosensitivity warnings), and the Realtime channel reconnects automatically with backoff. Kiosk mode ignores the hidden-tab disconnect.
- Freshness is shown in the status bar and is also audible and visible through the project's reactions.

## Settings (`/settings`)
- A searchable list grouped by category, with a toggle to an editable `settings.json` view. Both views edit the same object, validated on every change.
- Account uses Clerk `<UserProfile />`.
- Changes save to `user_settings.settings` 1 s after the last valid edit. The `settings.json` view keeps unparsable text local and shows the parse error until the text parses.
- `editor.keymap: "vim"` needs `@replit/codemirror-vim`, which is not installed; until it is, the editor uses the default keymap and the settings view says so.

## States
| State | Presentation |
|---|---|
| Loading | Skeletons in tables and panels; status bar indicators `…` with label "connecting" |
| Empty | Explanatory line and the primary action, for example "This project follows no groups. Add `sky.group(...)` to the script." |
| Error | Inline message with cause and Retry; build errors in Problems |
| Fresh | Circle-check icon and the source name |
| Stale | Clock icon, the source name and "stale since HH:MM" in the tooltip |
| Down | Circle-x icon, the source name and "down since HH:MM"; the console Sources panel shows the last error |

## Command palette
Opened with `Mod-Shift-P` or `Mod-K`. Typing filters commands by fuzzy match on the title (consecutive and word-start matches rank first). Commands that do not apply to the current screen are hidden; on screens without a piece only navigation commands remain. Commands:

| Command | Action |
|---|---|
| Run / Stop | Start or stop the piece |
| Panic | `allNotesOff` on every instrument, then Stop |
| New Project | Create from a template |
| Open Project | Fuzzy search of the user's projects |
| Toggle Console / Problems / IR / Trace | Show the bottom panel tab |
| Replay | Choose window and speed (1×, 10×, 100×, 1000×) |
| Go Live | Leave replay |
| Download Trace | Export JSONL |
| Open Settings | `/settings` |
| Open Guide | `/learn` |
| Run Fullscreen | `/projects/[id]/run` |

## Keyboard shortcuts
| Action | Shortcut |
|---|---|
| Run | `Mod-Enter` |
| Stop | `Mod-.` |
| Panic | `Escape` twice within 500 ms |
| Save | `Mod-S` |
| Command palette | `Mod-Shift-P`, `Mod-K` |
| Toggle bottom panel | `Mod-J` |
| Focus editor / preview | `Mod-1` / `Mod-2` |
| Open the guide's reference page | `F1` |

`Mod` is `Cmd` on macOS and `Ctrl` elsewhere.

## Editor completion
- `@codemirror/lang-javascript` in TypeScript mode provides syntax highlighting.
- `@valtown/codemirror-ts` connects CodeMirror to the type-check worker (`piece-dsl.md`, Type checking) for completion, hover types and lint diagnostics. The worker's library files are bundled with the app, so the editor makes no runtime requests for them.
- Until the type-check worker has loaded, a custom `CompletionSource` reads `PARAM_DEFS`, the effect registry, `src/visual/layer-defs.js` and `src/sky/groups.json` and completes builder names, options, group keys and field names.
- Type errors appear as `warn` (amber) underlines and as `type_error` warnings in Problems. Build and validator errors appear as `error` (red) underlines.

## Settings schema
```json
{
  "audio":  { "masterDb": -12, "maxMasterDb": 0 },
  "visual": { "reducedMotion": "system", "maxFlashesPerSecond": 3, "previewScale": 0.5 },
  "editor": { "fontSize": 14, "theme": "dark", "keymap": "default" },
  "data":   { "replaySpeed": 100, "consoleBuffer": 2000, "timeZone": "UTC",
              "observer": { "lat": 41.79, "lon": -87.60 } }
}
```
| Key | Values | Rule |
|---|---|---|
| `audio.masterDb` | −60 to `maxMasterDb` | Clamped |
| `audio.maxMasterDb` | −60 to 0 | Cannot exceed the engine maximum |
| `visual.reducedMotion` | `system`, `on` | `off` is not a value; the OS setting can only be made stricter |
| `visual.maxFlashesPerSecond` | 0 to 3 | Cannot exceed 3 |
| `visual.previewScale` | 0.25 to 1 | |
| `editor.fontSize` | 10 to 24 | |
| `editor.theme` | `dark`, `light` | |
| `editor.keymap` | `default`, `vim` | |
| `data.replaySpeed` | 1, 10, 100, 1000 | |
| `data.consoleBuffer` | 500 to 5000 | |
| `data.timeZone` | IANA zone name | Display only; stored times are UTC |
| `data.observer` | lat −90–90, lon −180–180 | Used by the `sky` projection |

Unknown keys are dropped. Invalid values fall back to defaults with a warning shown in the settings view.

Safety limits before and without stored settings:
- No piece session starts until settings have loaded (or the visitor is known to be signed out), so Run stays disabled and nothing plays at the default level above a stored `maxMasterDb`. When sign-in state is still unknown after 5 s, the page starts with the fallback below; settings that load later still apply.
- After each successful load or save, the page keeps the safety limits (`audio.masterDb`, `audio.maxMasterDb`, `visual.maxFlashesPerSecond`, `visual.reducedMotion`) in `localStorage` under `sphaerenmusik.safety`. When loading fails, or for the 5 s fallback, the page uses the defaults with each safety limit set to the stricter of the default and the stored copy.

## Sources
- CodeMirror, Autocompletion example: https://codemirror.net/examples/autocompletion/
- val-town/codemirror-ts: https://github.com/val-town/codemirror-ts
- Tailwind CSS v4, Theme variables: https://tailwindcss.com/docs/theme
