// Editor-side extensions that connect CodeMirror to the type-check worker (doc/ui.md, Editor):
// the worker facet, document sync, completion and hover. Adapted from @valtown/codemirror-ts 2.3.1
// (ISC, Copyright (c) 2023, Val Town). Importing that package's entry point would load the whole
// TypeScript compiler on the main thread; these need only CodeMirror, and the worker does the rest.

import { Facet, combineConfig } from '@codemirror/state';
import { EditorView, hoverTooltip } from '@codemirror/view';

/** The worker client and file path the other extensions read from editor state. */
export const tsFacetWorker = Facet.define({
  combine(configs) { return combineConfig(configs, {}); },
});

/** Sends the document to the worker on the first update and on every change. */
export function tsSyncWorker() {
  let first = true; // the first update carries the initial document without docChanged
  return EditorView.updateListener.of((update) => {
    const config = update.view.state.facet(tsFacetWorker);
    if (!config?.worker || (!update.docChanged && !first)) return;
    first = false;
    config.worker.updateFile({ path: config.path, code: update.state.doc.toString() });
  });
}

/** A completion source that asks the worker. */
export function tsAutocompleteWorker() {
  return async (/** @type {any} */ context) => {
    const config = context.state.facet(tsFacetWorker);
    if (!config?.worker) return null;
    return config.worker.getAutocompletion({ path: config.path, context: { pos: context.pos, explicit: context.explicit } });
  };
}

/** @param {any} info */
const renderTooltip = (info) => {
  const dom = document.createElement('div');
  for (const part of info.quickInfo?.displayParts ?? []) {
    const span = dom.appendChild(document.createElement('span'));
    span.className = `quick-info-${part.kind}`;
    span.innerText = part.text;
  }
  return { dom };
};

/** Hover types and documentation from the worker. */
export function tsHoverWorker() {
  return hoverTooltip(async (view, pos) => {
    const config = view.state.facet(tsFacetWorker);
    if (!config?.worker) return null;
    const info = await config.worker.getHover({ path: config.path, pos });
    if (!info) return null;
    return { pos: info.start, end: info.end, create: () => renderTooltip(info) };
  });
}
