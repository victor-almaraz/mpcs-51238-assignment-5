import Link from 'next/link';

type Props = { signedIn: boolean; learn?: { href: string; label: string }; highlight?: boolean };

const primary = 'inline-block rounded-sm bg-accent px-3 py-1.5 text-sm text-bg';
const secondary = 'inline-block rounded-sm border border-line px-3 py-1.5 text-sm hover:bg-panel-2';

/** `highlight`: Listen Now is the view's one accent action (doc/ui.md, Style); repeats are bordered. */
export function Actions({ signedIn, learn = { href: '/learn', label: 'Learn the Piece Script' }, highlight = true }: Props) {
  return (
    <nav aria-label="Get started" className="flex flex-wrap gap-2">
      <Link className={highlight ? primary : secondary} href="/listen">Listen Now</Link>
      {signedIn
        ? <Link className={secondary} href="/projects">Open Projects</Link>
        : <Link className={secondary} href="/sign-in">Start Composing</Link>}
      <Link className={secondary} href={learn.href}>{learn.label}</Link>
    </nav>
  );
}
