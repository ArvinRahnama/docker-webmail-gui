import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

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
