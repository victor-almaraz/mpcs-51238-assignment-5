import { auth } from '@clerk/nextjs/server';
import type { Metadata } from 'next';
import Link from 'next/link';
import { loadLanding } from '@/src/learn/landing.js';
import { Attribution } from '@/src/ui/attribution';
import { Actions } from './_landing/actions';
import { LiveSnapshot } from './_landing/live-snapshot';
import { LiveStrip } from './_landing/live-strip';
import { OrbitMap } from './_landing/orbit-map';
import { StringRatios } from './_landing/string-ratios';

export async function generateMetadata(): Promise<Metadata> {
  const { title, description } = await loadLanding();
  return { title: { absolute: title }, description, openGraph: { title, description } };
}

type Section = Awaited<ReturnType<typeof loadLanding>>['sections'][number];

const Prose = ({ s, className = '' }: { s: Section; className?: string }) => (
  <div className={`prose-landing ${className}`} dangerouslySetInnerHTML={{ __html: s.html }} />
);

/** One band: the heading in a narrow left column on wide windows, the body on the right. */
function Band({ s, n, tone = 'plain', children }: { s: Section; n: number; tone?: 'plain' | 'panel'; children: React.ReactNode }) {
  return (
    <section aria-labelledby={s.id} className={tone === 'panel' ? 'border-y border-line bg-panel' : ''}>
      <div className="mx-auto grid w-full max-w-6xl gap-x-12 gap-y-6 px-4 py-16 sm:px-6 lg:grid-cols-[15rem_1fr] lg:py-24">
        <div className="lg:sticky lg:top-20 lg:self-start">
          <p aria-hidden="true" className="tabular font-mono text-xs text-accent">{String(n).padStart(2, '0')}</p>
          <h2 id={s.id} className="mt-2 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{s.heading}</h2>
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

/** Section order and headings are fixed by doc/ui.md, Landing; tests/landing.test.js checks them. */
export default async function Landing() {
  const [{ sections }, { userId }] = await Promise.all([loadLanding(), auth()]);
  const signedIn = Boolean(userId);
  const [hero, spheres, quadrivium, app, how, honesty, reading] = sections;
  const link = 'rounded-sm px-2 py-1 text-fg-muted hover:bg-panel-2 hover:text-fg';

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-2.5 text-sm sm:px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <img src="/icon.svg" alt="" width={20} height={20} className="rounded-sm" />
            Sphärenmusik
          </Link>
          <nav aria-label="Site" className="flex gap-1">
            <Link href="/learn" className={link}>Guide</Link>
            <Link href="/console" className={link}>Console</Link>
            {signedIn
              ? <Link href="/projects" className={link}>Projects</Link>
              : <Link href="/sign-in" className={link}>Sign In</Link>}
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <LiveSnapshot>
          <section aria-labelledby={hero.id} className="landing-hero">
            <div className="mx-auto w-full max-w-6xl px-4 pt-14 pb-16 sm:px-6 lg:pt-24 lg:pb-24">
              <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.15fr] lg:gap-14">
                <div className="flex flex-col gap-7">
                  <h1 id={hero.id} className="text-5xl font-semibold tracking-tight sm:text-6xl">{hero.heading}</h1>
                  <Prose s={hero} className="prose-lead" />
                  <Actions signedIn={signedIn} />
                </div>
                <figure className="flex flex-col gap-2">
                  <OrbitMap />
                  <figcaption className="text-xs text-fg-muted">Space stations now, with their last 45 minutes of ground track. The shaded half is night.</figcaption>
                </figure>
              </div>
              <div className="mt-12"><LiveStrip /></div>
            </div>
          </section>
        </LiveSnapshot>
        <Band s={spheres} n={1}><Prose s={spheres} className="landing-timeline" /><StringRatios /></Band>
        <Band s={quadrivium} n={2}><Prose s={quadrivium} className="landing-quadrivium" /></Band>
        <Band s={app} n={3} tone="panel"><Prose s={app} className="landing-cards" /></Band>
        <Band s={how} n={4}>
          <Prose s={how} className="landing-how" />
          <div className="mt-8"><Actions signedIn={signedIn} highlight={false} learn={{ href: '/learn/first-piece', label: 'Your First Piece' }} /></div>
        </Band>
        <Band s={honesty} n={5} tone="panel"><Prose s={honesty} className="landing-statement" /></Band>
        <Band s={reading} n={6}><Prose s={reading} className="landing-reading" /></Band>
      </main>
      <Attribution />
    </div>
  );
}
