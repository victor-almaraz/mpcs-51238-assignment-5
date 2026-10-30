// Adapter for the layer property tables the DSL reads (src/visual/layer-defs.js, owned by the
// renderer). Expected shape: LAYER_DEFS[type] = { group: boolean, localOnly?: boolean,
//   props: { [name]: { type: 'number', min, max, default, unit? } | { type: 'color', default }
//            | { type: 'char', default } | { type: 'enum', options, default } } }

export { LAYER_DEFS } from '../visual/layer-defs.js';
