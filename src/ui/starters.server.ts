import 'server-only';
// Starter projects read at request time (doc/ui.md, Starter projects). next.config.ts traces
// content/starters/ into the server bundle for the routes that call this.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkManifest } from '@/src/ui/projects.js';

export type Starter = { slug: string; name: string; source: string; ir: unknown };

export async function loadStarters(): Promise<{ version: number; starters: Starter[] }> {
  const dir = join(process.cwd(), 'content', 'starters');
  const manifest = checkManifest(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));
  const starters = await Promise.all(manifest.starters.map(async (s) => ({
    slug: s.slug,
    name: s.name,
    source: await readFile(join(dir, `${s.slug}.ts`), 'utf8'),
    ir: JSON.parse(await readFile(join(dir, `${s.slug}.ir.json`), 'utf8')),
  })));
  return { version: manifest.version, starters };
}
