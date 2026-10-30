// Adapter for the group and field lists the DSL reads (src/sky/groups.json, owned by the sky store).
// Expected shape: { "<group>": { "source": "<registry id>", "orbit": boolean,
//   "fields": { "<field>": { "type": "number" | "string" | "boolean", "unit"?: string } } } }

import groups from '../sky/groups.json' with { type: 'json' };

export const GROUPS = groups;
