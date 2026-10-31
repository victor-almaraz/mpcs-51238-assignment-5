// Loads content/landing.md and splits it into sections (doc/ui.md, Landing).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import GithubSlugger from 'github-slugger';
import { remark } from 'remark';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { parse as parseYaml } from 'yaml';
import { renderMarkdown } from './guide.js';

export const LANDING_FILE = join(process.cwd(), 'content', 'landing.md');

const text = (node) => (node.type === 'text' || node.type === 'inlineCode' ? node.value : (node.children ?? []).map(text).join(''));

/**
 * Parse the landing copy. Each h1 or h2 starts a section that runs to the next one.
 * @returns {{ title: string, description: string, sections: { id: string, depth: number, heading: string, markdown: string, code: string[] }[] }}
 */
export function parseLanding(markdown) {
  const tree = remark().use(remarkFrontmatter).use(remarkGfm).parse(markdown);
  const yamlNode = tree.children.find((n) => n.type === 'yaml');
  const meta = yamlNode ? parseYaml(yamlNode.value) ?? {} : {};
  if (typeof meta.title !== 'string' || typeof meta.description !== 'string') {
    throw new Error('content/landing.md: front matter needs title and description');
  }
  const slugger = new GithubSlugger();
  const sections = [];
  for (const node of tree.children) {
    if (node.type === 'yaml') continue;
    if (node.type === 'heading' && node.depth <= 2) {
      const heading = text(node);
      sections.push({ id: slugger.slug(heading), depth: node.depth, heading, start: node.position.start.offset, code: [] });
      continue;
    }
    if (sections.length === 0) throw new Error('content/landing.md: text before the first heading');
    if (node.type === 'code') sections.at(-1).code.push(node.value);
  }
  sections.forEach((sec, i) => {
    sec.markdown = markdown.slice(sec.start, sections[i + 1]?.start ?? markdown.length).trim();
    delete sec.start;
  });
  return { title: meta.title, description: meta.description, sections };
}

/**
 * Landing copy with each section's body rendered to HTML. The heading is left out: the page
 * renders it from `heading` and `id` (doc/ui.md, Landing).
 * @returns {Promise<{ title: string, description: string, sections: { id: string, depth: number, heading: string, markdown: string, code: string[], html: string }[] }>}
 */
export async function loadLanding() {
  const landing = parseLanding(readFileSync(join(process.cwd(), 'content', 'landing.md'), 'utf8'));
  const sections = [];
  for (const sec of landing.sections) sections.push({ ...sec, html: await renderMarkdown(sec.markdown.replace(/^#{1,2} .*\n?/, ''), { slug: 'landing' }) });
  return { ...landing, sections };
}
