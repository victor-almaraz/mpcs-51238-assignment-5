# UI

## Scope
Routes, screens and their states, IDE layout patterns, the status bar, command palette, keyboard shortcuts, editor completion and the settings schema.

## Style
- Minimal and IDE-derived: flat panels, 1 px dividers, no shadows, no rounded corners above 4 px (`--radius-md` is 4 px, `--radius-sm` 2 px).
- Colour: black and white. Tokens are CSS variables in `app/globals.css`, mapped through Tailwind v4 `@theme inline`.
  - The dark theme is white on black and is the default; the light theme is black on white. There are no greys: `bg`, `panel` and `panel-2` are the page colour, and `line`, `fg`, `fg-muted` and `accent` are the text colour. Panels are separated by 1 px lines. Hierarchy comes from size, weight and position, not from tone.
  - Hover and selection invert: the item takes the text colour as its fill and the page colour as its text, as a terminal highlights a row. The current page in a navigation is also marked with a 2 px bar or an inverted row. Disabled bordered controls take a dashed border; disabled ghost controls are struck through.
  - Colour appears only in code and in the editor, in bright terminal hues. The syntax colours (`syn-keyword` magenta, `syn-string` green, `syn-number` yellow, `syn-function` cyan, `syn-type` blue) colour every code block. The status hues (`ok` green for live state, `warn` yellow for stale data, warnings and the Synthetic and Replay labels, `error` red for down sources and errors) apply inside `[data-palette="color"]`, which the editor sets on its root; elsewhere they are the text colour. Each state has a text label and a distinct icon shape, so colour is never the only signal.
  - Contrast: every text token is at least 4.5:1 (WCAG AA) on the page in its theme; the light theme uses darker versions of the same hues. `tests/palette.test.js` checks this and that the neutrals are pure black and white.
- Type: Inter (variable, SIL OFL 1.1) for interface text; JetBrains Mono (variable, SIL OFL 1.1) for code, identifiers (group keys, file names), the console, the status bar and numeric readouts. Both are bundled from `@fontsource-variable/*`, so pages make no font requests to third parties. Icons: Lucide (`lucide-react`, ISC) with a 2 px stroke, 12 to 16 px to match the adjacent text; every icon-only control has a text label for assistive technology and a tooltip.
- Text follows the GNOME HIG writing rules: header capitalization (Title Case without small words) for buttons, tabs, menu and palette commands, dialog headings, section labels and table columns; sentence case for body text, descriptions, check box labels, tooltips and notices. Nothing is set in all capitals.
- Each view has at most one highlighted (accent) action; other buttons are bordered.
- Errors say what happened and what to do, in plain words; technical detail goes to the trace and the console.
- Narrow windows: below 768 px the editor stacks editor, preview and bottom panel vertically and hides the side panel; the console stacks its group list above the panels; the guide stacks its page list above the page. No page scrolls sideways at 360 px.
- Modal dialogs (the start notice, the command palette) keep Tab and Shift-Tab inside the dialog and return focus to the element that opened them when they close.
- The preview and run mode always use the dark tokens (`data-theme="dark"` on their root), because the picture is drawn on black; text on them keeps WCAG AA contrast in either theme.

## Design system
The visual language comes from the geometry and symbols of the music of the spheres: concentric orbits around a centre, the ring graduated in degrees, planetary symbols, and the figures that frequency ratios draw. Every page builds from the parts below; no page defines its own header, brand, button or container. The palette is black and white (Style, Colour).

### Brand
- The mark: a centre, one orbit with one planet, and a graduated outer ring. It is drawn in `currentColor`, monochrome. `src/ui/brand.tsx` draws it; `app/icon.svg` is the same drawing on the dark `bg` for the favicon.
- The ring's graduation depends on the size: from 40 px a tick every 10°, longer every 30° and longest every 90°; from 24 px a tick every 30°, longer every 90°; below 24 px no ticks.
- The mark and the wordmark `Sphärenmusik` (Inter, semibold) always appear together and always link to `/`. The sign-in and sign-up pages show the mark alone above the form.
- Sizes: 24 px in the site header, 16 px in toolbars, 48 px above the sign-in and sign-up forms.

### Glyphs
One astronomical symbol per data family, drawn on Lucide's 16 px grid with a 1.5 px stroke (`src/ui/glyphs.tsx`). A glyph always means its family and is always paired with a text label.

| Glyph | Symbol | Family | Sources |
|---|---|---|---|
| Earth | ⊕ | Orbits | `celestrak.*` |
| Sun | ☉ | Space weather | `swpc.*` |
| Comet | ☄ | Close approaches and candidates | `jpl.*` |
| Ascending node | ☊ | Launches | `ll2.*` |

Glyphs mark the live strip tiles, the console's group list and the sky browser.

### Graduated rule
A 1 px line with ticks every 8 px, longer every 40 px, from the degree ring. It opens each landing section after the hero and each `h2` section of the guide (`.rule-graduated` and `--graduated` in `app/globals.css`). It is not used as a general divider: plain 1 px `line` dividers separate panels.

### Site header
Every document page (`/`, `/learn`, `/learn/[slug]`, `/sign-in`, `/sign-up`, `/projects`, `/settings`, `/console`, error pages, the Try mode "Example Not Found" page) opens with `SiteHeader` (`src/ui/site-header.tsx`):
- Sticky, 48 px high, full window width, `px-4 sm:px-6`, a 1 px bottom divider, solid `bg`.
- Left: the brand. Then the site navigation: Listen, Guide, Console. Right: the account area. Signed out, and while Clerk loads: Sign In (plain) and Sign Up (bordered). Signed in: Projects, Settings and the Clerk user button.
- The current section is marked with `aria-current="page"`, medium weight in the `accent` colour, and, from 640 px, a 2 px bar under the label.
- Below 640 px the navigation moves to a second row under the brand and the account area.

### Toolbar
The editor (`/projects/[id]` and `/try`) opens with a 36 px toolbar instead: the 16 px brand, a slash, the parent as a link (Projects, or the guide page of the example in Try mode), a slash, the view's title, then the view's controls on the right. The run views (`/listen`, `/projects/[id]/run`) show the same brand, slash and title in their auto-hiding chrome (Running); kiosk mode shows no chrome.

### Buttons and links
Class strings live in `src/ui/styles.ts`; components do not write their own.

| Kind | Use | Document pages (`md`) | Tool views (`sm`) |
|---|---|---|---|
| Primary | The view's one highlighted action | `accent` fill and border, `bg` text; inverted on hover | same, smaller |
| Secondary | Every other button | 1 px `line` border; inverted on hover | same, smaller |
| Ghost | Navigation items, toolbar links | no border; inverted on hover | same, smaller |

`md` is 32 px high with 12 px side padding and `text-sm`; `sm` is 22 px with 8 px padding and `text-xs`. Radius 4 px (`md`) and 2 px (`sm`).

A segmented control (a choice of two or three views, such as List and settings.json) is one bordered group 32 px high, the height of the `md` controls beside it, with 1 px dividers between options; the selected option is inverted (`segmented` in `src/ui/styles.ts`). Text inputs on document pages are 32 px high, the height of `md` buttons (`input`); text inputs and selects in tool views are 22 px high, the height of `sm` buttons (`inputSm`). A tab list (the bottom panel, the console) marks the selected tab with a 2 px `accent` bar under its label (`tab`).

Tables on document pages: every cell has 12 px horizontal and 10 px vertical padding (none at the outer edges), content centred vertically, one text size per column; the action column is right-aligned and uses `sm` buttons (`table` in `src/ui/styles.ts`).

The activity bar is 44 px wide; its 32 px items are centred with 6 px margins, the selected item inverted. Links inside body text are `accent` and underlined; navigation links are never underlined.

### Layout
- Spacing follows a 4 px grid. Document pages use 16–24 px panel padding; dense tool panes use 8–12 px.
- Containers: `page` (centred, at most 72 rem, `px-4 sm:px-6`, 40 px top padding) for the projects list, settings, error pages and the Try mode "Example Not Found" page; `form` (at most 28 rem, centred, 48 px top padding) for sign-in and sign-up. Guide articles are at most 46 rem wide (the width of `reading`); landing prose is at most 42 rem (`.prose-landing`).
- Side panels are 240 px wide. The guide's page list has 16 px side padding; the editor's side panel has 12 px padding. A panel's section label is `text-xs`, medium weight, `fg-muted`, 8 px above its content (`panelLabel`).
- Page titles (`h1`) are `text-2xl` (`text-3xl` from 640 px), semibold, tight tracking. Guide section headings (`h2`) are 1.25 rem (`text-xl`); landing section headings use the page-title size; settings group headings are body size, semibold, over a 1 px line.
- The attribution footer spans the window under document pages: a 1 px top divider, `px-4 sm:px-6`, 12 px vertical padding, `text-xs`.

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
| Hero | `# Sphärenmusik` | What the name means; the inspiration (music of the spheres, the quadrivium); one sentence on what the piece does | Live orbit map: `celestrak.stations` propagated in the page with `satellite.js` every 2 s and drawn on a 2D canvas in the `map` projection's equirectangular geometry, with a dotted graticule and dashed 45-minute ground-track trails on the day side, and the night side, bounded by the terminator computed from the subsolar point, inverted (filled with the text colour, with the graticule and trails drawn in the page colour); the ISS is labelled. Elements come from the live strip's snapshot. Drawn once per snapshot with reduced motion |
| Actions | | Listen Now (`/listen`, the one highlighted action), Start Composing (`/sign-in`; Open Projects when signed in), Learn the Piece Script (`/learn`) | Buttons |
| Live strip | | Kp, solar wind speed, stations in orbit, next launch name and time, each with its freshness icon and label | Four tiles at the foot of the hero: glyph and label, monospace value, freshness icon |
| Spheres | The music of the spheres | Pythagorean ratios; Plato, Boethius and Kepler; the physics caveat | The four sources as a timeline (a list, one bold title per item); a string divided at 2:1, 3:2 and 4:3, drawn as SVG with a text alternative |
| Quadrivium | Four sister sciences: the quadrivium | Plato's "sister sciences", Nicomachus's division, Boethius's term, the seven liberal arts | Plato's sentence as a pull quote; the division as a real 2 × 2 table styled as a grid, with the "In relation or in motion" column (music and astronomy) set off by a 2 px border |
| App | What Sphärenmusik does | The four kinds of live data and their sources; the ISS twenty octaves up | The four kinds of data as cards (a list, one bold title per item) |
| How | How it works | Four-step pipeline and the five-line script from `first-piece` | Numbered steps in two columns above the code block, highlighted with the editor's syntax colours; actions repeated, with Your First Piece (`/learn/first-piece`) in place of Learn |
| Honesty | What is real | Live data, composed mapping, no claim of sound in the sky | Set as a larger statement on a panel band |
| Reading | Further reading | Primary sources and one sourcebook | List |

- Layout: the site header; a hero with a display-size heading, the lead paragraph, the actions, the orbit map and the live strip; then one band per section. Each band opens with the graduated rule; on wide windows it puts a two-digit section number and the heading in a narrow left column, sticky while the band scrolls, and the body on the right; below 1024 px they stack. The App and Honesty bands sit on a `panel` band between 1 px lines. Headings come from the copy; the body renders without its heading so the page lays it out.
- The hero map does not use the WebGL renderer, so the landing page loads no shaders or Web Workers.
- Polling, propagation and drawing pause while the tab is hidden.
- The live strip reads `sky_objects` and `source_status` by REST through the publishable key on load and every 60 s; it opens no Realtime channel, so landing visitors use no Realtime messages. States: loading (`…` with "connecting"), fresh, stale and down as in States; a failed read shows "Live data unavailable" and keeps the rest of the page. Rows that fail validation are dropped and traced as `REALTIME` / `landing` / `invalid_row` (`warn`).
- The landing page starts no audio and creates no `AudioContext`. Sound starts only on `/listen` after a click.
- Visual safety applies (`visuals.md`): the orbit view has no flashes, honors reduced motion and pauses when the tab is hidden.
- Signed-in visitors see the same page with Open Projects in place of Start Composing; there is no redirect.
- States: the copy is static, so the page has no loading state apart from the live strip and the orbit view, which shows a static map until positions arrive.

## Sign-in (`/sign-in`) and sign-up (`/sign-up`)
- The site header, then a `form` container: the 48 px mark, Clerk `<SignIn />` (or `<SignUp />`, each linking to the other), a "Listen Without an Account" link to `/listen`, and a "Learn the Piece Script" link to `/learn`. When Clerk cannot load, a status message titled "Sign-In Unavailable" replaces the form and points to those links.
- Signed-in visitors are redirected to `/projects`.
- States: loading (Clerk component placeholder), error (Clerk inline error).

## Projects (`/projects`)
- Table with columns name, groups followed, last edited, last run. Row actions: Open, Run, Duplicate, Delete.
- Last edited is `projects.updated_at`; every save sets it. `projects` has no last-run column, so last run is recorded per browser in `localStorage` (`sphaerenmusik.lastRun.<id>`) when Run starts the project, and reads `—` on other devices.
- "New Project" offers Blank and each starter project as a template. Creating a project inserts the row and then its `project_subscriptions`; when the subscriptions cannot be written, the new row is deleted and the error is shown, so a retry reuses the same name.
- On first sign-in the list contains the starter projects (Starter projects).
- Delete sets `deleted_at` and removes the row from the table with a toast "Project deleted" and an Undo button for 10 s. The `prune-projects` job deletes rows a day after `deleted_at`.
- Below the table, a line links to Your first piece (`/learn/first-piece`).
- States: loading (dashed skeleton rows), empty ("No projects." with a New Project: Blank button, one button per starter template and the link to Your first piece), error (message and Retry). A failed starter seeding shows its error above the table with a Dismiss button.

### Starter projects
Every account receives simple example projects on its first visit to `/projects`, so a first-time user can press Run and hear a piece without writing code.

- Source: `content/starters/manifest.json` lists each starter's `slug` and `name`; `content/starters/<slug>.ts` holds its script. Each script starts with comments that state what it plays and which guide pages explain it.
- Build: `scripts/build-starters.mjs` removes types with Sucrase, builds every starter with the builder and validator in Node, type-checks it against `builder.d.ts`, and writes `content/starters/<slug>.ir.json`. It fails on any error, warning or type diagnostic. `npm run build` runs it as the last step of `npm run generate`, before `next build`; `--check` fails when a stored `.ir.json` differs from the build instead of writing it.
- Seeding: when `user_settings.starters_version` is below the manifest `version`, the `/projects` server component inserts each starter not yet present (matched by `projects.starter_slug`) with its `name`, `source`, `ir` and `project_subscriptions`, through the user's Clerk-authenticated client under RLS, then sets `starters_version`. The insert and update run in one RPC call, `seed_starters(p_version, p_projects)`, so a reload during seeding creates no duplicates.
- Starters are ordinary projects: the user can edit, rename or delete them. Deleted starters are not recreated, because `starters_version` is already current.
- A manifest `version` increase adds starters that an account does not have and leaves existing projects unchanged.

## Editor (`/projects/[id]`)
```
┌─────────────────────────────────────────────────── [◧][⬓][◨] Commands ┐
├──┬───────────────┬──────────────────────────────────────────────────┤
│▣ │ EXPLORER      │ ▶ Run  ■ Stop  ⊗ Panic   Master ━━━●━━  ▮▮▯ dBFS │
│  │               ├────────────────────────────┬─────────────────────┤
│  │               │ piece.ts                   │ PREVIEW             │
│⌕ │  piece.ts     │  1 scale('D', 'lydian');   │                     │
│◉ │ SKY           │  2                         │                     │
│⚙ │  ▸ celestrak  │  3 const stations = ...    │                     │
│  │  ▸ swpc       │                            │                     │
│  │  ▸ jpl        ├────────────────────────────┴─────────────────────┤
│  │  ▸ ll2        │ CONSOLE   PROBLEMS   IR   TRACE                  │
│  │               │ 14:02:11 CHANGE jpl.scout:P21kQ3x enter {...}    │
├──┴───────────────┴──────────────────────────────────────────────────┤
│ ✓ swpc.kp  ◷ jpl.cad stale        │ ▷ playing  12/64 │ −18 dBFS │ Saved │
└─────────────────────────────────────────────────────────────────────┘
```
| Region | Content |
|---|---|
| Activity bar | Explorer, Search, Sky, Guide, Settings. Explorer, Search and Sky choose the side panel; clicking the selected one again hides it. Guide and Settings open `/learn` and `/settings` in a new tab |
| Explorer | The project name (click to rename; not in Try mode), `piece.ts`, and the sky browser |
| Search | Case-insensitive search of the lines of `piece.ts`; clicking a hit moves the cursor to its line |
| Sky browser | Groups by provider (`celestrak`, `swpc`, `jpl`, `ll2`), each with its fields and units. Followed groups are marked "followed" with their object count and show each field's value from one object. Clicking a field inserts `field('<name>')` at the cursor; clicking a group name opens `/learn/sky-data` |
| Transport strip | One row across the top of the editor and preview: Run, Stop, Panic, the master volume and the level meter |
| Editor | CodeMirror 6, TypeScript mode, with completion, hover types and inline problems from the type-check worker |
| Preview | Visual output at reduced resolution, with the piece's notices below it |
| Bottom panel | Console, Problems, IR (read-only compiled JSON), Trace. The Console tab holds the Sources, Events, Voices, Modulation and Effects panels (plus Synthetic with `?dev=1`), the pause control and the replay controls |
| Status bar | Per-source freshness, replay or synthetic mode, audio state, voices in use out of 64, output level, save state |

Behavior:
- Run is the user gesture that starts the AudioContext (`bindings.md`). Before the first Run, the preview shows "Press Run to start sound" ("Loading the audio engine…" until the engine is ready). The first Run in a page opens the start notice with the volume and photosensitivity warnings; later Runs start at once.
- Toolbar controls, right to left: Commands (opens the command palette), the three layout toggles, then Run Fullscreen in a saved project, or Save as Project (signed in) or Sign In to Save (signed out) in Try mode. Run Fullscreen saves a pending edit first; a modified click (new tab or window) keeps the browser's behaviour.
- Saving rebuilds the IR and hot-reloads the running piece (`piece-dsl.md`). A failed build focuses Problems and leaves the running piece unchanged.
- A piece with handlers restarts its program on every successful save (`piece-dsl.md`, Hot reload). `handler_error` and `handler_timeout` problems from the running program appear in Problems next to the build problems and clear on the next Run or save.
- Autosave writes `source` and `ir` to `projects` 2 s after the last edit, then syncs `project_subscriptions` to the IR's groups; `Mod-S` saves at once. Save state: `Saved`, `Saving…`, `Unsaved changes`, `Offline`, `Save failed`. Leaving the page with an unsaved edit asks for confirmation.
- Try mode rebuilds 2 s after the last edit and on `Mod-S`, without saving (`guide.md`, Try mode).
- Hot reload never starts audio; only Run does.
- Stop, Panic and Restart Audio win over a Run that is still starting: when the start completes after one of them, the piece is stopped at once and the audio state stays `stopped` or `muted`. A Reset after a Panic therefore never brings back a piece that was starting.
- Layout: the side panel (Explorer, Search or Sky), the preview and the bottom panel can each be hidden, so the editor can take the window. Three toggle buttons on the right of the toolbar (Lucide `PanelLeft`, `PanelBottom`, `PanelRight`, in that order, with `aria-pressed`, inverted while the part shows, and the shortcut in the tooltip) show and change their state; the shortcuts and the palette commands below do the same. The layout is kept in `localStorage` under `sphaerenmusik.layout` and restored on the next visit. All three are shown by default. A failed build shows the bottom panel on Problems.
- Hiding the preview keeps the piece running and its picture state; only the pane is hidden.
- The transport strip spans the top of the editor and preview, and no layout toggle hides it, so Panic is always visible (`audio/audio-safety.md`, Safety UI). It holds Run, Stop, Panic, the master volume and the level meter with its Limit badge. The master volume starts at `audio.masterDb` and cannot exceed `audio.maxMasterDb`. The transport never moves between places: remounting it would reset the slider's shown value while the engine kept its level.
- The sky store follows the groups of the last successful build; after a save they equal the project's `project_subscriptions`.
- Save writes `local_only = true` when the IR has `localOnly` (`piece-dsl.md`, Escape hatch).

### Status bar
| Item | Content |
|---|---|
| Freshness | One icon and registry id per source of the followed groups, or per known source when no group is followed; stale, down and connecting sources add the words `stale`, `down` or `connecting`. The tooltip reads "<id>: stale since HH:MM" or "<id>: down since HH:MM" in `data.timeZone`, with "UTC" appended when the zone is UTC. Before any status arrives the bar shows one `connecting` item |
| Mode | `Replay ×<speed>` during replay, `Synthetic` while test events play |
| Note | "Visuals unavailable (WebGL2)" without WebGL2; "Vim keymap unavailable" when `editor.keymap` is `vim` |
| Audio | An icon and a word: `stopped` (square), `starting` (spinner), `playing` (play), `muted` after Panic (speaker off), `fault` after a safety fault (warning triangle) |
| Voices | Sounding voices out of 64 |
| Level | Post-limiter peak in dBFS, `−∞` when silent, followed by `Limit` while the limiter acts |
| Save | `Saved`, `Saving…`, `Unsaved changes`, `Offline`, `Save failed` (the error in the tooltip); `Scratch` in Try mode |

## Running (`/projects/[id]/run`)
- The preview fills the window. The cursor and the chrome (title, transport, links) start hidden and appear on pointer movement, a tap or a key press; they hide again after 3 s without any. They stay while the pointer is over the chrome, while focus is inside it (keyboard use, the start notice) and while the start notice is open. While hidden and stopped, the preview reads "Move the pointer or press a key to show the controls"; while shown and stopped, "Press Run to start sound".
- The chrome holds the 16 px brand, a slash, the piece name, the transport, the key hint and the links: Editor on `/projects/[id]/run`; How It Works (`/learn/first-piece`), Console and Compose (`/projects`) on `/listen`.
- Overlays toggle independently: console (`C`), sounding voices (`N`), status bar (`S`). The status bar shows at first, except in kiosk mode. The keys are ignored while focus is in a text field or a modifier key is held.
- `Escape` is Panic in every run view (`/listen`, `/projects/[id]/run`, kiosk included), as `audio/audio-safety.md` (Safety UI) requires; the chrome also keeps the Panic button. `E` returns to the editor, which stops the piece, as does the Editor link in the chrome. The chrome's key hint reads "Esc panic · C console · N voices · S status", plus "· E editor" where there is an editor.
- Installation mode (`?kiosk=1`): no cursor, no chrome, no `E` key, a single "Begin Listening" click starts audio (the button reads "Loading…" until the piece can run and carries the volume and photosensitivity warnings), and the Realtime channel reconnects automatically with backoff. Kiosk mode ignores the hidden-tab disconnect. A Panic in kiosk mode holds until the page is reloaded: no Reset is reachable without the chrome.
- `/listen` plays the stored IR of the `station-chord` starter. `/projects/[id]/run` for a project without a compiled IR shows an error page with a link to the editor.
- Freshness is shown in the status bar and is also audible and visible through the project's reactions.
- A piece whose stored IR has `program` is built from its `source` in the sandbox before it plays, since its handlers live only in the VM. A build error shows the error state with a link to the editor. Pieces without handlers play from the stored IR.

## Settings (`/settings`)
- A searchable list grouped by category (Audio, Visual, Editor, Data), with a List / settings.json segmented control that switches to an editable `settings.json` view. Both views edit the same object, validated on every change; validation warnings are listed above the settings. The search field is disabled in the `settings.json` view.
- The save state (`Saved`, `Saving…`, `Unsaved changes`, `Save failed`) shows beside the page title.
- An Account section below the settings holds Clerk `<UserProfile />`.
- Changes save to `user_settings.settings` 1 s after the last valid edit; a change still waiting when the visitor leaves the page is saved at once. The `settings.json` view keeps unparsable text local and shows the parse error until the text parses.
- `editor.keymap: "vim"` requires `@replit/codemirror-vim`, which is not installed, so the editor uses the default keymap; the setting's description and the editor's status bar say so.

## States
| State | Presentation |
|---|---|
| Loading | Dashed skeletons in tables and panels; status bar items with a spinner icon and the label `connecting` |
| Empty | Explanatory line and the primary action, for example "No projects." with the New Project buttons on `/projects` |
| Error | Inline message with cause and Retry; build errors in Problems |
| Fresh | Circle-check icon and the source id |
| Stale | Clock icon, the source id, the label `stale`, and "stale since HH:MM" in the tooltip |
| Down | Circle-x icon, the source id, the label `down`, and "down since HH:MM" in the tooltip; the console Sources panel shows the last error |

## Command palette
The editor (`/projects/[id]` and `/try`) has a command palette, opened with `Mod-Shift-P`, `Mod-K` or the toolbar's Commands button. Typing filters commands by fuzzy match on the title (prefix, consecutive and word-start matches rank first). Commands are listed in `src/ui/palette.js`; each command's `needs` hides it where it does not apply: signed-out visitors do not see New Project, Open Project or Open Settings, and Try mode does not show Run Fullscreen. Commands:

| Command | Action |
|---|---|
| Run / Stop | Start or stop the piece |
| Panic | `allNotesOff` on every instrument, then Stop |
| Save | Save at once (`Mod-S`) |
| New Project | Create from Blank or a starter template |
| Open Project | Fuzzy search of the user's projects |
| Toggle Console / Problems / IR / Trace | Show the bottom panel on that tab |
| Toggle Side Panel / Preview / Bottom Panel | Show or hide that part of the layout |
| Replay | Choose a window (last hour, 6 hours, 24 hours or 7 days), then a speed (1×, 10×, 100×, 1000×) |
| Go Live | Leave replay |
| Download Trace | Export JSONL |
| Open Settings | `/settings` in a new tab |
| Open Guide | `/learn` in a new tab |
| Run Fullscreen | Save, then open `/projects/[id]/run` |

## Keyboard shortcuts
| Action | Shortcut |
|---|---|
| Run | `Mod-Enter` |
| Stop | `Mod-.` |
| Panic | `Escape` twice within 500 ms |
| Save | `Mod-S` |
| Command palette | `Mod-Shift-P`, `Mod-K` |
| Toggle side panel | `Mod-B` |
| Toggle preview | `Mod-Alt-B` |
| Toggle bottom panel | `Mod-J` |
| Focus editor / preview | `Mod-1` / `Mod-2` |
| Open the guide's reference page in a new tab | `F1` |

These shortcuts apply in the editor; `src/ui/shortcuts.js` holds the table. The editor handles them in the capture phase, so CodeMirror's own bindings for the same keys do not run. `Escape` counts toward Panic only while the command palette is closed. The run views use single keys instead (Running). `Mod` is `Cmd` on macOS and `Ctrl` elsewhere.

## Editor completion
- `@codemirror/lang-javascript` in TypeScript mode provides syntax highlighting.
- `@valtown/codemirror-ts` connects CodeMirror to the type-check worker (`piece-dsl.md`, Type checking) for completion, hover types and lint diagnostics. The worker's library files are bundled with the app, so the editor makes no runtime requests for them.
- Until the type-check worker has loaded, a custom `CompletionSource` reads `PARAM_DEFS`, the effect registry, `src/visual/layer-defs.js` and `src/sky/groups.json` and completes builder names, options, group keys and field names.
- Type errors appear as wavy `warn` (yellow) underlines and as `type_error` warnings in Problems. Build and validator errors appear as wavy `error` (red) underlines; build and validator warnings use the `warn` underline. When the type-check worker fails to load, the editor shows "Type checking unavailable".

## Settings schema
```json
{
  "audio":  { "masterDb": -12, "maxMasterDb": 0 },
  "visual": { "reducedMotion": "system", "maxFlashesPerSecond": 3, "previewScale": 1 },
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
| `visual.previewScale` | 0.25 to 1 | A fraction of the display's resolution (device pixel ratio, at most 2) |
| `editor.fontSize` | 10 to 24 | |
| `editor.theme` | `dark`, `light` | Sets `data-theme` on the document of every screen that loads settings; the preview and run views stay dark |
| `editor.keymap` | `default`, `vim` | `vim` falls back to the default keymap (Settings) |
| `data.replaySpeed` | 1, 10, 100, 1000 | |
| `data.consoleBuffer` | 500 to 5000 | |
| `data.timeZone` | IANA zone name | Display only; stored times are UTC |
| `data.observer` | lat −90–90, lon −180–180 | Used by the `sky` projection and the `elevation` orbit quantity; the default is the University of Chicago |

`src/lib/settings.js` validates the object. Unknown keys are dropped. Invalid values fall back to defaults with a warning shown in the settings view; an `audio.masterDb` above `audio.maxMasterDb` is clamped to it instead.

Safety limits before and without stored settings:
- No piece session starts until settings have loaded (or the visitor is known to be signed out), so Run stays disabled and nothing plays at the default level above a stored `maxMasterDb`. When sign-in state is still unknown after 5 s, the page starts with the fallback below; settings that load later still apply.
- After each successful load or save, the page keeps the safety limits (`audio.masterDb`, `audio.maxMasterDb`, `visual.maxFlashesPerSecond`, `visual.reducedMotion`) in `localStorage` under `sphaerenmusik.safety`. When loading fails, or for the 5 s fallback, the page uses the defaults with each safety limit set to the stricter of the default and the stored copy.

## Sources
- CodeMirror, Autocompletion example: https://codemirror.net/examples/autocompletion/
- val-town/codemirror-ts: https://github.com/val-town/codemirror-ts
- Tailwind CSS v4, Theme variables: https://tailwindcss.com/docs/theme
