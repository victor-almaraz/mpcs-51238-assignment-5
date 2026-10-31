import { ClerkFailed, SignIn } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Attribution } from '@/src/ui/attribution';

export const metadata = { title: 'Sign in' };

export default async function SignInPage() {
  const { userId } = await auth();
  if (userId) redirect('/projects');
  return (
    <div className="flex min-h-screen flex-col">
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-12">
        <h1 className="text-2xl font-semibold">Sphärenmusik</h1>
        <SignIn signUpUrl="/sign-up" fallbackRedirectUrl="/projects" />
        <ClerkFailed>
          <section role="status" className="rounded-sm border border-line bg-panel p-4">
            <h2 className="mb-1 font-semibold">Sign-In Unavailable</h2>
            <p className="text-sm text-fg-muted">The sign-in service could not load. Reload the page to try again. You can listen and learn the piece script without an account.</p>
          </section>
        </ClerkFailed>
        <nav className="flex flex-col gap-2 text-sm">
          <Link className="underline" href="/listen">Listen Without an Account</Link>
          <Link className="underline" href="/learn">Learn the Piece Script</Link>
        </nav>
      </main>
      <Attribution />
    </div>
  );
}
