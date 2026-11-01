// Shared class strings (doc/ui.md, Design system). Components use these instead of their own.

type Kind = 'primary' | 'secondary' | 'ghost';
type Size = 'md' | 'sm';

const BASE = 'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap disabled:pointer-events-none disabled:border-dashed';
const SIZE: Record<Size, string> = { md: 'h-8 rounded-md px-3 text-sm', sm: 'h-[22px] rounded-sm px-2 text-xs' };
const KIND: Record<Kind, string> = {
  primary: 'border border-accent bg-accent font-medium text-bg hover:bg-bg hover:text-fg',
  secondary: 'border border-line hover:bg-fg hover:text-bg',
  ghost: 'hover:bg-fg hover:text-bg disabled:line-through',
};

/** Button or button-styled link. `md` on document pages, `sm` in tool views. */
export const button = (kind: Kind = 'secondary', size: Size = 'md') => `${BASE} ${SIZE[size]} ${KIND[kind]}`;

/** Link inside body text. */
export const textLink = 'text-accent underline underline-offset-2';

export const container = {
  page: 'mx-auto w-full max-w-6xl px-4 pt-10 pb-16 sm:px-6',
  reading: 'mx-auto w-full max-w-[46rem]',
  form: 'mx-auto flex w-full max-w-md flex-col gap-6 px-4 pt-12 pb-16',
};

export const heading = {
  page: 'text-2xl font-semibold tracking-tight sm:text-3xl',
  section: 'text-xl font-semibold tracking-tight',
};

/** Section label inside a side panel. */
export const panelLabel = 'mb-2 text-xs font-medium text-fg-muted';
