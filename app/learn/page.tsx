import type { Metadata } from 'next';
import { GuideShell } from './guide-shell';
import { guideProps } from './load';

export const metadata: Metadata = { title: 'Learn the piece script' };

export default async function LearnIndex() {
  const { props } = await guideProps('index');
  return <GuideShell {...props} />;
}
