import Link from 'next/link';
import { Attribution } from '@/src/ui/attribution';

type PageLink = { slug: string; title: string };
type Heading = { depth: number; text: string; id: string };

export function GuideShell({ pages, current, headings, html }: { pages: PageLink[]; current: string; headings: Heading[]; html: string }) {
  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex flex-1">
        <nav aria-label="Guide pages" className="w-56 shrink-0 border-r border-line bg-panel p-3 text-sm">
          <div className="mb-2 font-mono text-xs uppercase text-fg-muted">Guide</div>
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
        <main className="min-w-0 flex-1 px-8 py-6">
          <article className="prose-guide" dangerouslySetInnerHTML={{ __html: html }} />
        </main>
        <nav aria-label="On this page" className="hidden w-56 shrink-0 border-l border-line p-3 text-sm lg:block">
          <div className="mb-2 font-mono text-xs uppercase text-fg-muted">On this page</div>
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
