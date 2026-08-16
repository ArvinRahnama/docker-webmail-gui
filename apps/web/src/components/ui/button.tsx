import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * shadcn/ui-shaped Button, restyled entirely through tokens (no default
 * shadcn zinc/slate palette survives here). §8's destructive-action rules
 * ("never the only [button] styled prominently", "never the
 * default-focused element") are enforced by ConfirmDialog's own layout,
 * not by this component — `destructive` is just a colour variant, callers
 * are responsible for not making it the only prominent action.
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-body font-medium transition-colors duration-fast ease-standard disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
        secondary:
          'border border-border-default bg-bg-surface text-text-primary hover:bg-bg-raised hover:border-border-strong',
        ghost: 'text-text-primary hover:bg-bg-raised',
        destructive: 'bg-status-critical-fg text-accent-fg hover:opacity-90',
        link: 'text-accent underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-body-sm [&_svg]:size-3.5',
        default: 'h-9 px-4 [&_svg]:size-4',
        lg: 'h-10 px-6 text-body [&_svg]:size-4',
        icon: 'size-9 [&_svg]:size-4',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Render as the single child element (e.g. a router `<Link>`) via Radix Slot instead of a `<button>`. */
  asChild?: boolean;
  /** Shows a spinner in place of the leading icon and disables the button, without changing its size/label position. */
  pending?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, pending = false, disabled, children, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled ?? pending}
        aria-busy={pending || undefined}
        {...props}
      >
        {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
        {children}
      </Comp>
    );
  },
);
Button.displayName = 'Button';
