import { Toaster as SonnerToaster } from 'sonner';
import { useTheme } from '@/theme/theme-provider';

/**
 * sonner is used as-is per §7's component inventory ("Standard shadcn/ui
 * components ... Toast/Sonner ... used as-is, restyled through tokens
 * only") — this wrapper supplies the app's resolved theme and maps its
 * CSS-variable hooks onto our tokens instead of sonner's own palette.
 */
export function Toaster() {
  const { resolvedTheme } = useTheme();

  return (
    <SonnerToaster
      theme={resolvedTheme}
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            'rounded-md border border-border-default bg-bg-raised text-text-primary shadow-md text-body-sm',
          title: 'text-text-primary font-medium',
          description: 'text-text-secondary',
          actionButton: 'bg-accent text-accent-fg',
          cancelButton: 'bg-bg-inset text-text-secondary',
          error: 'border-status-critical-fg/30',
          success: 'border-status-healthy-fg/30',
          warning: 'border-status-warning-fg/30',
        },
      }}
    />
  );
}
