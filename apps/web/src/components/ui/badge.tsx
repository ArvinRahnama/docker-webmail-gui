import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/**
 * Generic chip — counts, "New" tags, filter pills. Not for status; see
 * `components/status/status-badge.tsx` for the 6-state, icon+text status
 * chip §7 specifies separately (colour must never be the only signal,
 * which a generic Badge has no obligation to enforce).
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-caption font-medium',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-accent-subtle-bg text-accent',
        outline: 'border-border-default text-text-secondary',
        neutral: 'border-transparent bg-bg-inset text-text-secondary',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
