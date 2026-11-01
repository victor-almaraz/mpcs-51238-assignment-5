# User guide page

## Scope
The `/learn` pages that teach people to write piece scripts: content location and format, routes, rendering, runnable examples, links from the editor, and the tests that keep the guide consistent with the builder API.

## Job
Render the guide's Markdown pages and make every example runnable in one click.

## Content
- Source files: `content/learn/*.md`. One file is one page; the file name without `.md` is the page slug.
- Each file starts with YAML front matter:
  ```yaml
  ---
  title: Expressions
  order: 3
  ---
  ```
  `order` sets the position in the navigation. `index.md` has order 0 and renders at `/learn`.
- Body: CommonMark with GitHub tables. Links between pages use the bare slug, for example `[Sky data](sky-data)`.
- Code blocks with the info string `ts piece` are **runnable examples**: complete scripts that build without errors and type-check without errors. Code blocks with `ts` are fragments and are neither run nor checked.

| Page | Slug |
|---|---|
| Learn the Piece Script | `index` |
| Your first piece | `first-piece` |
| Sky data | `sky-data` |
| Expressions | `expressions` |
| Sound | `sound` |
| Effects and modulation | `effects-and-modulation` |
| Visuals | `visuals` |
| Live data states | `live-data-states` |
| Recipes | `recipes` |
| Reference | `reference` |
| Troubleshooting | `troubleshooting` |

## Routes
| Route | Access | Content |
|---|---|---|
| `/learn` | Public | `index.md` |
| `/learn/[slug]` | Public | One page |
| `/try?src=<slug>/<n>` | Public | The editor loaded with the `n`-th runnable example (0-based) of page `slug` |

`/learn` and `/try` are public routes in `proxy.ts` (`auth.md`).

## Rendering
- Pages render at build time with `generateStaticParams` over `content/learn/`. Markdown is parsed with `remark`, `remark-gfm` and `remark-frontmatter`, and converted with `remark-rehype` and `rehype-slug` (heading anchors).
- Layout: the site header (`ui.md`, Design system), then three columns: the page list in `order` (a 240 px side panel, sticky, scrolling on its own), the page in a `reading` column centred in the remaining width, and the page's headings in a right-hand outline (224 px, sticky, from 1280 px). Below 768 px the page list becomes a Guide Pages disclosure above the page.
- Code blocks use the editor's monospace font and theme. Each runnable example shows a **Try It** button that opens `/try?src=<slug>/<n>`.

## Try mode
- `/try` opens the editor with an unsaved scratch project containing the example. Run, hot reload, the console, replay and test events work as in a saved project.
- Scratch projects are not written to `projects`. A signed-in user can choose **Save as Project**; a signed-out user sees **Sign In to Save**.
- Try mode follows the example's groups without writing `project_subscriptions`. The sky store subscribes to the IR's `groups` directly.

## Links from the app
| Location | Link |
|---|---|
| Command palette | "Open guide" → `/learn` |
| `F1` in the editor | `/learn/reference` |
| Problems panel | Each problem links to `/learn/troubleshooting#<code>` |
| Sky browser | Each group header links to `/learn/sky-data` |
| Landing page and sign-in screen | "Learn the Piece Script" → `/learn` |
| Starter project scripts | Header comments name the guide pages that explain them |
| Projects empty state | "Learning the script? Start with Your first piece" → `/learn/first-piece` |

`troubleshooting.md` renders each problem code in its own table row with an anchor id equal to the code.

## Consistency
The guide restates facts held in code. Tests (`testing.md`) fail when they diverge:

| Guide content | Source of truth |
|---|---|
| Runnable examples | Builder, validator and type checker: each `ts piece` block builds and type-checks with zero errors |
| Instrument parameter tables in `reference.md` | `PARAM_DEFS` |
| Effect parameter tables | Effect registry |
| Layer property table | `src/visual/layer-defs.js` |
| Groups and fields in `sky-data.md` | `src/sky/groups.json` |
| Problem codes in `troubleshooting.md` | `src/dsl/problem-codes.js` |
| Limits in `reference.md` | Validator constants |

A change to the builder API, a parameter range, a group, a layer property, a problem code or a limit includes the matching guide change in the same commit.

## Style
The guide follows the same writing rules as these docs: formal register, present tense, imperative instructions, one term per concept. It addresses the reader as "you" in instructions. It explains musical and astronomical terms where they first appear and links to the reference for full tables.

## Accessibility
- Pages use one `h1`, ordered headings and real tables.
- **Try It** buttons are labelled "Try It: <first heading above the block>". They are bordered, not highlighted: a page has many.
- The page list is a `nav` landmark; the outline is a second `nav` labelled "On This Page".

## Sources
- remark: https://github.com/remarkjs/remark
- Next.js, `generateStaticParams`: https://nextjs.org/docs/app/api-reference/functions/generate-static-params
