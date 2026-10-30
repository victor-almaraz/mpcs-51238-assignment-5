import type { Metadata } from 'next';
import { AppProviders } from '@/src/ui/app-providers';
import { ErrorState } from '@/src/ui/error-state';
import { loadProject } from '@/src/ui/load-project.server';
import { RunView } from '@/src/ui/run-view';

export const metadata: Metadata = { title: 'Run' };

/** Running project, fullscreen; `?kiosk=1` for installation mode (doc/ui.md, Running). */
export default async function RunPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const { project, error } = await loadProject(id);
  if (!project) return <ErrorState title="Run" message={error ?? 'The project could not be loaded'} />;
  if (!project.ir) {
    return <ErrorState title={project.name} message="This project has no compiled piece yet. Open it in the editor and fix the problems it shows." back={{ href: `/projects/${id}`, label: 'Editor' }} />;
  }
  const kiosk = sp.kiosk === '1';
  return (
    <AppProviders>
      <RunView ir={project.ir} name={project.name} projectId={project.id} backHref={kiosk ? null : `/projects/${id}`} kiosk={kiosk} />
    </AppProviders>
  );
}
