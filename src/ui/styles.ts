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

/** Text input on document pages: the height of an `md` button. */
export const input = 'h-8 rounded-md border border-line bg-bg px-3 text-sm placeholder:text-fg-muted disabled:border-dashed';

/** Text input or select in tool views: the height of an `sm` button. */
export const inputSm = 'h-[22px] rounded-sm border border-line bg-bg px-1 text-xs placeholder:text-fg-muted disabled:border-dashed';

/** Tab in a tab list: the selected tab carries a 2 px accent bar under its label. */
export const tab = (selected: boolean) => `border-b-2 px-2 py-1 ${selected ? 'border-accent' : 'border-transparent hover:border-line'}`;

/** Segmented control: one bordered group, 1 px dividers, the selected option inverted. */
export const segmented = {
  group: 'inline-flex h-8 shrink-0 overflow-hidden rounded-md border border-line text-sm',
  option: (selected: boolean) => `px-3 whitespace-nowrap [&+&]:border-l [&+&]:border-line ${selected ? 'bg-fg text-bg' : 'hover:bg-fg hover:text-bg'}`,
};

/** Table cells on document pages: 12 px by 10 px, centred, no padding at the outer edges. */
export const table = {
  table: 'w-full border-collapse text-sm',
  head: 'border-b border-line text-left text-xs font-medium',
  th: 'px-3 py-2.5 align-middle font-medium first:pl-0 last:pr-0',
  row: 'border-b border-line',
  td: 'px-3 py-2.5 align-middle first:pl-0 last:pr-0',
};

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
