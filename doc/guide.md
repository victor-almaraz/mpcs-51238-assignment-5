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
| Programs | `programs` |
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
- `src/learn/guide.js` loads and renders the pages. Pages render at build time with `generateStaticParams` over `content/learn/`; `dynamicParams` is false, so any other slug renders the 404 page. Markdown is parsed with `remark`, `remark-gfm` and `remark-frontmatter`, and converted with `remark-rehype`, `rehype-slug` (heading anchors) and `rehype-stringify`. Bare-slug links become `/learn/<slug>` links. `readPageSource` returns null only for an invalid slug or a missing file (`ENOENT`), which renders the 404 page; any other read error fails the build. A page without front matter, a `title` or an integer `order` also fails the build.
- Layout: the site header (`ui.md`, Design system), then three columns: the page list in `order` under the label Guide (a 240 px side panel, sticky, scrolling on its own, the current page inverted), the article (at most 46 rem) centred in the remaining width, and an outline of the page's `h2` and `h3` headings under the label On This Page (224 px, sticky, from 1280 px). Below 768 px the page list becomes a "Guide Pages · <current page>" disclosure above the page. The attribution footer closes the page.
- `ts`, `typescript`, `js` and `javascript` code blocks are highlighted at build time with the editor's syntax classes (`src/learn/highlight.js`) and set in the editor's monospace font. Each runnable example is followed by a **Try It** link, styled as a bordered button, that opens `/try?src=<slug>/<n>`.

## Try mode
- `/try` opens the editor with an unsaved scratch project containing the example. The page is prerendered with every runnable example; the client picks the one named by `src`. An unknown or missing `src` shows "Example Not Found" with a link to `/learn`.
- The toolbar reads `Try: <heading>`, where the heading is the last heading above the example, and its parent link returns to the example's guide page. The status bar's save state reads `Scratch`.
- Run, hot reload, the console, replay and test events work as in a saved project. The script rebuilds 2 s after the last edit and on `Mod-S`.
- Scratch projects are not written to `projects`. A signed-in user can choose **Save as Project**, which creates a project named after the example's heading and opens it in the editor; a signed-out user sees **Sign In to Save**, which links to `/sign-in` and returns to the example afterwards.
- Try mode follows the example's groups without writing `project_subscriptions`. The sky store subscribes to the IR's `groups` directly.

## Links from the app
| Location | Link |
|---|---|
| Site header | Guide → `/learn` |
| Command palette | Open Guide → `/learn`, in a new tab |
| Editor activity bar | Guide → `/learn`, in a new tab |
| `F1` in the editor | `/learn/reference`, in a new tab |
| Problems panel | Each problem code links to `/learn/troubleshooting#<code>` |
| Sky browser | Each group name links to `/learn/sky-data` |
| Landing page, sign-in and sign-up screens | "Learn the Piece Script" → `/learn` |
| Landing page, How it works | "Your First Piece" → `/learn/first-piece` |
| `/listen` | "How It Works" → `/learn/first-piece` |
| Starter project scripts | Header comments name the guide pages that explain them |
| Blank project script | A comment names `/learn/first-piece` |
| Projects list and its empty state | "Learning the script? Start with Your first piece" → `/learn/first-piece` |

`troubleshooting.md` renders each problem code in its own table row with an anchor id equal to the code.

## Consistency
The guide restates facts held in code. Tests (`testing.md`) fail when they diverge: `tests/guide.test.js` checks front matter, internal links, that examples build, and the instrument, effect, field and limit tables; `tests/types.test.js` type-checks the examples; `tests/visual-layer-defs.test.js` checks the layer table; `tests/dsl-codes.test.js` checks the problem codes.

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
- **Try It** links are labelled "Try It: <last heading above the block>". They are bordered, not highlighted: a page has many.
- The page list is a `nav` landmark labelled "Guide pages"; the outline is a second `nav` labelled "On This Page".

## Sources
- remark: https://github.com/remarkjs/remark
- Next.js, `generateStaticParams`: https://nextjs.org/docs/app/api-reference/functions/generate-static-params
