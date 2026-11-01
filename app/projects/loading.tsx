import { SiteHeader } from '@/src/ui/site-header';
import { container } from '@/src/ui/styles';

export default function Loading() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <div className={container.page} aria-busy="true" aria-label="Loading projects">
        <div className="mb-6 h-9 w-48 border border-dashed border-line" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="mb-2 flex gap-4 border-b border-line py-2">
            <div className="h-4 w-1/4 border border-dashed border-line" />
            <div className="h-4 w-1/4 border border-dashed border-line" />
            <div className="h-4 w-1/6 border border-dashed border-line" />
          </div>
        ))}
      </div>
    </div>
  );
}
