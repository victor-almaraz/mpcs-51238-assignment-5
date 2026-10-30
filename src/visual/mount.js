/**
 * DOM convenience for the UI (doc/visuals.md, Interface): creates a canvas
 * that fills `container`, or the text summary when WebGL2 is unavailable.
 */
import { createRenderer } from './renderer.js';
import { UNAVAILABLE_STATUS } from './summary.js';

/**
 * @param {HTMLElement} container
 * @param {import('./renderer.js').RendererOptions & { groups?: string[] }} options
 */
export function mountVisuals(container, options = {}) {
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.setAttribute('aria-label', 'Visual output');
  canvas.setAttribute('role', 'img');
  container.appendChild(canvas);
  const renderer = createRenderer(canvas, options);
  if (renderer.available) {
    const r = /** @type {any} */ (renderer);
    const dispose = r.dispose.bind(r);
    r.dispose = () => { dispose(); canvas.remove(); };
    return r;
  }
  canvas.remove();
  const box = document.createElement('div');
  box.setAttribute('role', 'status');
  box.className = 'visual-summary';
  const title = document.createElement('p');
  title.textContent = UNAVAILABLE_STATUS;
  const list = document.createElement('ul');
  box.append(title, list);
  container.appendChild(box);
  const r = /** @type {any} */ (renderer);
  if (options.groups) r.setGroups(options.groups);
  const render = () => {
    list.replaceChildren(...r.summaryLines().map((/** @type {string} */ line) => {
      const li = document.createElement('li');
      li.textContent = line;
      return li;
    }));
  };
  render();
  for (const name of ['setLayers', 'setGroups']) {
    const f = r[name].bind(r);
    r[name] = (/** @type {any} */ arg) => { f(arg); render(); };
  }
  r.dispose = () => { box.remove(); };
  return r;
}
