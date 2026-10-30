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

/** Section order and headings are fixed by doc/ui.md, Landing; tests/landing.test.js checks them. */
export default async function Landing() {
  const [{ sections }, { userId }] = await Promise.all([loadLanding(), auth()]);
  const signedIn = Boolean(userId);
  const [hero, spheres, quadrivium, app, how, honesty, reading] = sections;
  const prose = (s: (typeof sections)[number], extra = '') => (
    <div className={`prose-guide prose-landing ${extra}`} dangerouslySetInnerHTML={{ __html: s.html }} />
  );
  const section = (s: (typeof sections)[number], body: React.ReactNode) => (
    <section key={s.id} aria-labelledby={s.id} className="border-t border-line py-10">{body}</section>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-line px-4 py-2 font-mono text-sm">
        <span>Sphärenmusik</span>
        <nav aria-label="Site" className="flex gap-4">
          <Link href="/learn" className="hover:underline">Guide</Link>
          <Link href="/console" className="hover:underline">Console</Link>
          {signedIn
            ? <Link href="/projects" className="hover:underline">Projects</Link>
            : <Link href="/sign-in" className="hover:underline">Sign in</Link>}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4">
        <LiveSnapshot>
          <section aria-labelledby={hero.id} className="grid items-center gap-8 py-10 lg:grid-cols-[1fr_1.1fr]">
            <div className="flex flex-col gap-5">
              {prose(hero, 'prose-hero')}
              <Actions signedIn={signedIn} />
              <LiveStrip />
            </div>
            <OrbitMap />
          </section>
        </LiveSnapshot>
        {section(spheres, <>{prose(spheres)}<StringRatios /></>)}
        {section(quadrivium, prose(quadrivium, 'prose-quadrivium'))}
        {section(app, prose(app))}
        {section(how, <>{prose(how)}<div className="mt-6"><Actions signedIn={signedIn} learn={{ href: '/learn/first-piece', label: 'Your first piece' }} /></div></>)}
        {section(honesty, prose(honesty))}
        {section(reading, prose(reading, 'text-sm'))}
      </main>
      <Attribution />
    </div>
  );
}
