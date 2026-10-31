// Highlights TypeScript and JavaScript code blocks at render time with the editor's classes.
import { highlightCode } from '@lezer/highlight';
import { parser } from '@lezer/javascript';
import { visit } from 'unist-util-visit';
import { syntaxHighlighter } from '../ui/syntax.js';

const LANGS = { ts: 'ts', typescript: 'ts', js: '', javascript: '' };
const parsers = new Map();
const parserFor = (dialect) => {
  if (!parsers.has(dialect)) parsers.set(dialect, parser.configure({ dialect }));
  return parsers.get(dialect);
};

/** rehype plugin: replaces the text of `pre > code.language-{ts,js}` with highlighted spans. */
export function rehypeHighlight() {
  return (tree) => {
    visit(tree, 'element', (node, _i, parent) => {
      if (node.tagName !== 'code' || parent?.tagName !== 'pre') return;
      const lang = (node.properties?.className ?? []).map((c) => String(c).replace(/^language-/, '')).find((c) => c in LANGS);
      if (lang === undefined) return;
      const text = node.children.map((c) => c.value ?? '').join('');
      const children = [];
      highlightCode(text, parserFor(LANGS[lang]).parse(text), syntaxHighlighter,
        (value, classes) => children.push(classes
          ? { type: 'element', tagName: 'span', properties: { className: classes.split(' ') }, children: [{ type: 'text', value }] }
          : { type: 'text', value }),
        () => children.push({ type: 'text', value: '\n' }));
      node.children = children;
    });
  };
}
