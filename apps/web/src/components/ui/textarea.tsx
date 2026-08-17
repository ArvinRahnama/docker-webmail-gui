import { forwardRef } from 'react';
import type { TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/** `Input`'s multi-line counterpart — same visual language, for the Sieve script editor and the autoresponder message (`security/sieve-editor-page.tsx`, `security/autoresponder-page.tsx`). No prior `Textarea` primitive existed in `components/ui/`; this mirrors `input.tsx` exactly rather than inventing a new style. */
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-32 w-full rounded-sm border border-border-default bg-bg-surface px-3 py-2 text-body text-text-primary shadow-sm transition-colors duration-fast ease-standard placeholder:text-text-muted',
        'hover:border-border-strong',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border-default',
        'aria-[invalid=true]:border-status-critical-fg',
        className,
      )}
      {...props}
    />
  );
});
Textarea.displayName = 'Textarea';
