import { forwardRef } from 'react';
import type { ComponentPropsWithoutRef, ElementRef } from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '@/lib/cn';

/**
 * §10: "All form fields have real `<label>` associations." A thin restyle
 * of Radix Label (which just renders a real `<label>` plus click-to-focus
 * on its associated control) rather than a plain `<label>` tag, so every
 * form in the app gets that association through one component instead of
 * each call site remembering `htmlFor`.
 */
export const Label = forwardRef<
  ElementRef<typeof LabelPrimitive.Root>,
  ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      'text-body-sm font-medium text-text-primary peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;
