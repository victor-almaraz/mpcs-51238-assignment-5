'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

/** Inline error with cause and Retry (doc/ui.md, States). */
export function ErrorState({ title, message, back = { href: '/projects', label: 'Projects' } }: { title: string; message: string; back?: { href: string; label: string } }) {
  const router = useRouter();
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="mb-3 text-xl font-semibold">{title}</h1>
      <p role="alert" className="mb-4 text-sm text-down">{message}</p>
      <div className="flex gap-2 text-xs">
        <button type="button" className="rounded-sm border border-line px-2 py-0.5 hover:bg-panel-2" onClick={() => router.refresh()}>Retry</button>
        <Link className="rounded-sm border border-line px-2 py-0.5 hover:bg-panel-2" href={back.href}>{back.label}</Link>
      </div>
    </main>
  );
}
