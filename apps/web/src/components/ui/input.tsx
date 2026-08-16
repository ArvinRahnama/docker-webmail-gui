import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        className={cn(
          'flex h-9 w-full rounded-sm border border-border-default bg-bg-surface px-3 py-1 text-body text-text-primary shadow-sm transition-colors duration-fast ease-standard placeholder:text-text-muted',
          'file:border-0 file:bg-transparent file:text-body-sm file:font-medium',
          'hover:border-border-strong',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border-default',
          'aria-[invalid=true]:border-status-critical-fg',
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';
