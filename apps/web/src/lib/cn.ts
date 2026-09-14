import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The project's type scale (`--text-*` in styles/index.css's @theme). Stock
 * tailwind-merge only knows t-shirt sizes, so without this it reads
 * `text-caption` as a text *colour* and a later `text-text-secondary` in
 * the same cn() call silently deletes the font size (and a later size
 * deletes an earlier colour). Keep in sync with index.css.
 */
const FONT_SIZE_TOKENS = [
  'display',
  'h1',
  'h2',
  'h3',
  'body',
  'body-sm',
  'caption',
  'mono',
  'mono-sm',
];

const twMerge = extendTailwindMerge({ extend: { theme: { text: FONT_SIZE_TOKENS } } });

/**
 * Standard shadcn/ui `cn` helper: `clsx` for conditional class composition,
 * `tailwind-merge` so a later conflicting utility (e.g. a caller passing
 * `bg-status-critical-bg` to override a component's default `bg-bg-surface`)
 * wins instead of both classes landing in the DOM and racing on CSS
 * specificity/source order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
