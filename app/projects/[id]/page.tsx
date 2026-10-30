import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AppProviders } from '@/src/ui/app-providers';
import { ErrorState } from '@/src/ui/error-state';
import { loadProject } from '@/src/ui/load-project.server';
import { loadStarters } from '@/src/ui/starters.server';
import { Workbench } from '@/src/ui/workbench';

export const metadata: Metadata = { title: 'Editor' };

/** The editor (doc/ui.md, Editor). */
export default async function EditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ project, error }, { starters }] = await Promise.all([loadProject(id), loadStarters()]);
  if (!project) return <ErrorState title="Editor" message={error ?? 'The project could not be loaded'} />;
  return (
    <AppProviders>
      <Suspense>
        <Workbench mode="project" project={{ id: project.id, name: project.name }} initialSource={project.source} initialIr={project.ir} signedIn templates={starters} />
      </Suspense>
    </AppProviders>
  );
}
