import Link from 'next/link';
import { Attribution } from '@/src/ui/attribution';
import { SiteHeader } from '@/src/ui/site-header';
import { panelLabel } from '@/src/ui/styles';

type PageLink = { slug: string; title: string };
type Heading = { depth: number; text: string; id: string };

function PageList({ pages, current }: { pages: PageLink[]; current: string }) {
  return (
    <ul className="flex flex-col">
      {pages.map((p) => {
        const here = p.slug === current;
        return (
          <li key={p.slug}>
            <Link
              href={p.slug === 'index' ? '/learn' : `/learn/${p.slug}`}
              aria-current={here ? 'page' : undefined}
              className={`-mx-2 block rounded-sm px-2 py-1 ${here ? 'bg-fg font-medium text-bg' : 'hover:bg-fg hover:text-bg'}`}
            >
              {p.title}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Guide layout (doc/guide.md, Rendering): page list, reading column, outline. */
export function GuideShell({ pages, current, headings, html }: { pages: PageLink[]; current: string; headings: Heading[]; html: string }) {
  const outline = headings.filter((h) => h.depth === 2 || h.depth === 3);
  const currentTitle = pages.find((p) => p.slug === current)?.title ?? 'Guide';
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <div className="flex flex-1 flex-col md:flex-row">
        <nav aria-label="Guide pages" className="hidden w-60 shrink-0 border-r border-line text-sm md:block">
          <div className="sticky top-12 max-h-[calc(100dvh-3rem)] overflow-y-auto px-4 py-8">
            <div className={panelLabel}>Guide</div>
            <PageList pages={pages} current={current} />
          </div>
        </nav>
        <details className="border-b border-line text-sm md:hidden">
          <summary className="cursor-pointer px-4 py-3">Guide Pages <span className="font-medium">· {currentTitle}</span></summary>
          <nav aria-label="Guide pages" className="px-4 pb-4"><PageList pages={pages} current={current} /></nav>
        </details>
        <main className="min-w-0 flex-1 px-4 pt-8 pb-16 sm:px-8 lg:px-12 lg:pt-12">
          <article className="prose-guide mx-auto w-full max-w-[46rem]" dangerouslySetInnerHTML={{ __html: html }} />
        </main>
        {outline.length > 0 && (
          <nav aria-label="On This Page" className="hidden w-56 shrink-0 text-sm xl:block">
            <div className="sticky top-12 max-h-[calc(100dvh-3rem)] overflow-y-auto px-4 py-8">
              <div className={panelLabel}>On This Page</div>
              <ul className="flex flex-col gap-1.5 border-l border-line">
                {outline.map((h) => (
                  <li key={h.id} className={h.depth === 3 ? 'pl-6' : 'pl-3'}>
                    <a href={`#${h.id}`} className="hover:underline">{h.text}</a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        )}
      </div>
      <Attribution />
    </div>
  );
}
