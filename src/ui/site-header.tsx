'use client';

import { UserButton, useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Brand } from './brand';
import { button } from './styles';

const SITE = [
  { href: '/listen', label: 'Listen' },
  { href: '/learn', label: 'Guide' },
  { href: '/console', label: 'Console' },
];

const isCurrent = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

function NavLink({ href, label, path }: { href: string; label: string; path: string }) {
  const current = isCurrent(path, href);
  return (
    <Link
      href={href}
      aria-current={current ? 'page' : undefined}
      className={`${button('ghost')} relative ${current ? 'font-medium text-accent sm:after:absolute sm:after:inset-x-3 sm:after:-bottom-2 sm:after:h-0.5 sm:after:bg-accent' : ''}`}
    >
      {label}
    </Link>
  );
}

/** The header of every document page (doc/ui.md, Design system, Site header). Sign In and Sign Up show until Clerk reports a session. */
export function SiteHeader() {
  const path = usePathname() ?? '/';
  const { isLoaded, isSignedIn } = useAuth();
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg">
      <div className="flex min-h-12 flex-wrap items-center gap-x-4 px-4 sm:flex-nowrap sm:px-6">
        <div className="flex h-12 items-center"><Brand /></div>
        <nav aria-label="Site" className="order-last -mx-3 flex w-full gap-1 pb-2 sm:order-none sm:mx-0 sm:w-auto sm:pb-0">
          {SITE.map((l) => <NavLink key={l.href} {...l} path={path} />)}
        </nav>
        <span className="flex-1" />
        <div className="flex h-12 items-center gap-1" aria-label="Account">
          {isLoaded && isSignedIn ? (
            <>
              <NavLink href="/projects" label="Projects" path={path} />
              <NavLink href="/settings" label="Settings" path={path} />
              <span className="ml-2 flex"><UserButton /></span>
            </>
          ) : (
            <>
              <Link href="/sign-in" aria-current={isCurrent(path, '/sign-in') ? 'page' : undefined} className={button('ghost')}>Sign In</Link>
              <Link href="/sign-up" aria-current={isCurrent(path, '/sign-up') ? 'page' : undefined} className={button('secondary')}>Sign Up</Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
