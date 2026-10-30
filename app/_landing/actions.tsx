import Link from 'next/link';

type Props = { signedIn: boolean; learn?: { href: string; label: string } };

const primary = 'inline-block rounded-sm bg-accent px-3 py-1.5 font-mono text-sm text-bg';
const secondary = 'inline-block rounded-sm border border-line px-3 py-1.5 font-mono text-sm hover:bg-panel-2';

export function Actions({ signedIn, learn = { href: '/learn', label: 'Learn the piece script' } }: Props) {
  return (
    <nav aria-label="Get started" className="flex flex-wrap gap-2">
      <Link className={primary} href="/listen">Listen now</Link>
      {signedIn
        ? <Link className={secondary} href="/projects">Open projects</Link>
        : <Link className={secondary} href="/sign-in">Start composing</Link>}
      <Link className={secondary} href={learn.href}>{learn.label}</Link>
    </nav>
  );
}
