import type { Metadata } from 'next';
import { loadGuide } from '@/src/learn/guide.js';
import { GuideShell } from '../guide-shell';
import { guideProps } from '../load';

export const dynamicParams = false;

export function generateStaticParams() {
  return loadGuide().filter((p) => p.slug !== 'index').map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: (await guideProps(slug)).title };
}

export default async function LearnPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { props } = await guideProps(slug);
  return <GuideShell {...props} />;
}
