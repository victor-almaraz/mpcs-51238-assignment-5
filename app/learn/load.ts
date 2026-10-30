import 'server-only';
import { notFound } from 'next/navigation';
import { loadGuide, readPageSource, renderPage } from '@/src/learn/guide.js';

export async function guideProps(slug: string) {
  const pages = loadGuide();
  const page = pages.find((p) => p.slug === slug);
  const source = page ? readPageSource(slug) : null;
  if (!page || source === null) notFound();
  return {
    title: page.title,
    props: {
      pages: pages.map((p) => ({ slug: p.slug, title: p.title })),
      current: slug,
      headings: page.headings,
      html: await renderPage(page, source),
    },
  };
}
