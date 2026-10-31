// Syntax classes shared by the editor and the code blocks of the guide and landing page
// (doc/ui.md, Style). The colours are the syn-* tokens in app/globals.css.
import { tagHighlighter, tags as t } from '@lezer/highlight';

export const syntaxHighlighter = tagHighlighter([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], class: 'syn-keyword' },
  { tag: [t.string, t.special(t.string), t.regexp], class: 'syn-string' },
  { tag: [t.number, t.bool, t.null], class: 'syn-number' },
  { tag: t.comment, class: 'syn-comment' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'syn-function' },
  { tag: [t.typeName, t.className, t.namespace], class: 'syn-type' },
]);
