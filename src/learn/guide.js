// Loads and renders the user guide in content/learn/ (doc/guide.md).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import GithubSlugger from 'github-slugger';
import { remark } from 'remark';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { visit } from 'unist-util-visit';
import { parse as parseYaml } from 'yaml';


const SLUG = /^[a-z0-9-]+$/;

/** True for a code block with the info string `ts piece`. */
export const isRunnable = (node) => node.type === 'code' && node.lang === 'ts' && /(^|\s)piece(\s|$)/.test(node.meta ?? '');

function plainText(node) {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  return (node.children ?? []).map(plainText).join('');
}

/**
 * Parse one page's Markdown without rendering it.
 * @returns {{ slug, title, order, tree, headings: {depth, text, id}[], examples: {source, heading}[] }}
 */
export function parsePage(slug, markdown) {
  const tree = remark().use(remarkFrontmatter).use(remarkGfm).parse(markdown);
  const yamlNode = tree.children.find((n) => n.type === 'yaml');
  if (!yamlNode) throw new Error(`content/learn/${slug}.md: missing front matter`);
  const meta = parseYaml(yamlNode.value) ?? {};
  if (typeof meta.title !== 'string' || meta.title === '') throw new Error(`content/learn/${slug}.md: front matter needs title`);
  if (!Number.isInteger(meta.order)) throw new Error(`content/learn/${slug}.md: front matter needs integer order`);
  const headings = [];
  const examples = [];
  const slugger = new GithubSlugger();
  let lastHeading = meta.title;
  visit(tree, (node) => {
    if (node.type === 'heading') {
      lastHeading = plainText(node);
      headings.push({ depth: node.depth, text: lastHeading, id: slugger.slug(lastHeading) });
    } else if (isRunnable(node)) {
      examples.push({ source: node.value, heading: lastHeading });
    }
  });
  return { slug, title: meta.title, order: meta.order, tree, headings, examples };
}

/** Every page in content/learn/, sorted by `order`. */
export function loadGuide() {
  const pages = readdirSync(join(process.cwd(), 'content', 'learn'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const slug = f.slice(0, -3);
      if (!SLUG.test(slug)) throw new Error(`content/learn/${f}: file name must be a lowercase slug`);
      return parsePage(slug, readFileSync(join(process.cwd(), 'content', 'learn', f), 'utf8'));
    });
  return pages.sort((a, b) => a.order - b.order);
}

/** Attach a "Try it" link after each runnable example. */
function remarkTryIt({ slug }) {
  return (tree) => {
    let n = 0;
    let lastHeading = '';
    visit(tree, (node, index, parent) => {
      if (node.type === 'heading') lastHeading = plainText(node);
      if (!isRunnable(node) || !parent) return;
      node.data = { ...node.data, hProperties: { 'data-piece': String(n) } };
      const link = {
        type: 'paragraph',
        data: { hProperties: { className: ['try-it'] } },
        children: [{
          type: 'link', url: `/try?src=${slug}/${n}`,
          data: { hProperties: { 'aria-label': `Try It: ${lastHeading}` } },
          children: [{ type: 'text', value: 'Try It' }],
        }],
      };
      parent.children.splice(index + 1, 0, link);
      n++;
      return index + 2;
    });
  };
}

/** Rewrite bare-slug links (`sky-data`, `sound#triggers`) to `/learn/<slug>`. */
function remarkGuideLinks() {
  return (tree) => {
    visit(tree, 'link', (node) => {
      const m = /^([a-z0-9-]+)(#[a-z0-9-]+)?$/.exec(node.url);
      if (m) node.url = `/learn/${m[1] === 'index' ? '' : m[1]}${m[2] ?? ''}`.replace(/\/$/, '') || '/learn';
    });
  };
}

/** Problem code rows in troubleshooting.md get an anchor id equal to the code. */
function rehypeCodeAnchors() {
  return (tree) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'tr') return;
      const first = node.children.find((c) => c.type === 'element');
      const code = first?.children?.[0];
      if (code?.type !== 'element' || code.tagName !== 'code') return;
      const text = code?.children?.[0]?.value;
      if (text && /^[a-z][a-z0-9_]*$/.test(text)) node.properties = { ...node.properties, id: text };
    });
  };
}

/** Render Markdown to HTML with the guide pipeline. `slug` names the page for Try it links. */
export async function renderMarkdown(markdown, { slug, codeAnchors = false }) {
  const file = await remark()
    .use(remarkFrontmatter)
    .use(remarkGfm)
    .use(remarkTryIt, { slug })
    .use(remarkGuideLinks)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(codeAnchors ? rehypeCodeAnchors : () => undefined)
    .use(rehypeStringify)
    .process(markdown);
  return String(file);
}

/** Render one page to HTML. */
export function renderPage(page, markdown) {
  return renderMarkdown(markdown, { slug: page.slug, codeAnchors: page.slug === 'troubleshooting' });
}

export function readPageSource(slug) {
  if (!SLUG.test(slug)) return null;
  try {
    return readFileSync(join(process.cwd(), 'content', 'learn', `${slug}.md`), 'utf8');
  } catch {
    return null;
  }
}
