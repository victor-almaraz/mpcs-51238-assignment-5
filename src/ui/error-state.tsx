'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Attribution } from './attribution';
import { SiteHeader } from './site-header';
import { button, container, heading } from './styles';

/** Inline error with cause and Retry (doc/ui.md, States). */
export function ErrorState({ title, message, back = { href: '/projects', label: 'Projects' } }: { title: string; message: string; back?: { href: string; label: string } }) {
  const router = useRouter();
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className={`${container.page} flex-1`}>
        <h1 className={`${heading.page} mb-4`}>{title}</h1>
        <p role="alert" className="mb-6 text-sm">{message}</p>
        <div className="flex gap-2">
          <button type="button" className={button('secondary')} onClick={() => router.refresh()}>Retry</button>
          <Link className={button('secondary')} href={back.href}>{back.label}</Link>
        </div>
      </main>
      <Attribution />
    </div>
  );
}
