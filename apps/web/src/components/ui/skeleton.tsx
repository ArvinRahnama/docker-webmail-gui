import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * §9 "Loading — skeleton: layout is known ... skeleton matches final
 * geometry to avoid shift." This component supplies the pulse animation
 * only; matching geometry is the caller's job (pass `className` with the
 * real width/height of what will replace it).
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-sm bg-bg-inset', className)} {...props} />;
}
