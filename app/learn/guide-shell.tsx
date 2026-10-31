import Link from 'next/link';
import { Attribution } from '@/src/ui/attribution';

type PageLink = { slug: string; title: string };
type Heading = { depth: number; text: string; id: string };

export function GuideShell({ pages, current, headings, html }: { pages: PageLink[]; current: string; headings: Heading[]; html: string }) {
  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex flex-1 flex-col md:flex-row">
        <nav aria-label="Guide pages" className="w-full shrink-0 border-b border-line bg-panel p-3 text-sm md:w-56 md:border-b-0 md:border-r">
          <div className="mb-2 text-xs text-fg-muted">Guide</div>
          <ul className="flex flex-col gap-1">
            {pages.map((p) => (
              <li key={p.slug}>
                <Link
                  href={p.slug === 'index' ? '/learn' : `/learn/${p.slug}`}
                  aria-current={p.slug === current ? 'page' : undefined}
                  className={p.slug === current ? 'text-accent' : 'hover:underline'}
                >
                  {p.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main className="min-w-0 flex-1 px-4 py-6 md:px-8">
          <article className="prose-guide" dangerouslySetInnerHTML={{ __html: html }} />
        </main>
        <nav aria-label="On this page" className="hidden w-56 shrink-0 border-l border-line p-3 text-sm lg:block">
          <div className="mb-2 text-xs text-fg-muted">On This Page</div>
          <ul className="flex flex-col gap-1">
            {headings.filter((h) => h.depth === 2 || h.depth === 3).map((h) => (
              <li key={h.id} className={h.depth === 3 ? 'pl-3' : undefined}>
                <a href={`#${h.id}`} className="hover:underline">{h.text}</a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <Attribution />
    </div>
  );
}
