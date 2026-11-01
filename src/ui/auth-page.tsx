import { ClerkFailed } from '@clerk/nextjs';
import Link from 'next/link';
import { Attribution } from './attribution';
import { Mark } from './brand';
import { SiteHeader } from './site-header';
import { container, textLink } from './styles';

/** Sign-in and sign-up (doc/ui.md, Sign-in and sign-up): the Clerk form in a `form` container. */
export function AuthPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className={`${container.form} flex-1 items-center`}>
        <Mark size={48} />
        <h1 className="sr-only">{title}</h1>
        {children}
        <ClerkFailed>
          <section role="status" className="w-full rounded-md border border-line p-4">
            <h2 className="mb-1 font-semibold">{title} Unavailable</h2>
            <p className="text-sm">The sign-in service could not load. Reload the page to try again. You can listen and learn the piece script without an account.</p>
          </section>
        </ClerkFailed>
        <nav aria-label="Without an account" className="flex flex-col items-center gap-2 text-sm">
          <Link className={textLink} href="/listen">Listen Without an Account</Link>
          <Link className={textLink} href="/learn">Learn the Piece Script</Link>
        </nav>
      </main>
      <Attribution />
    </div>
  );
}
