import { SignIn } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Attribution } from '@/src/ui/attribution';

export default async function Home() {
  const { userId } = await auth();
  if (userId) redirect('/projects');
  return (
    <div className="flex min-h-screen flex-col">
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-12">
        <h1 className="text-2xl font-semibold">Sphärenmusik</h1>
        <p className="text-fg-muted">
          Music and images played by live space data: satellites, the solar wind, passing asteroids and rocket launches.
        </p>
        <SignIn routing="hash" signUpUrl="/sign-up" fallbackRedirectUrl="/projects" />
        <nav className="flex flex-col gap-2 font-mono text-sm">
          <Link className="underline" href="/listen">Listen without an account</Link>
          <Link className="underline" href="/learn">Learn the piece script</Link>
        </nav>
      </main>
      <Attribution />
    </div>
  );
}
