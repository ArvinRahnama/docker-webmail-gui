import { useSyncExternalStore } from 'react';
import { Toaster as SonnerToaster } from 'sonner';
import { useTheme } from '@/theme/theme-provider';

/**
 * Phones (narrow, or short in landscape): a centred dialog's footer and
 * lower fields sit exactly where a bottom toast lands, and a Radix modal
 * makes the toast un-dismissable (body pointer-events:none) until it times
 * out — e.g. "Password generated. Copy it now" covering the password.
 * Top-center only ever overlaps a dialog's title there.
 */
const COMPACT_VIEWPORT_QUERY = '(max-width: 639px), (max-height: 480px)';

/**
 * Top offset for a top-center toast: the app header (app-layout.tsx) is a
 * 56px sticky bar, so a toast at sonner's default 16/32px would sit over
 * the menu, search, notification and account buttons for its lifetime.
 * Passed as both `offset` and `mobileOffset` (sonner swaps to the latter
 * at 600px and below); only `top` is set, so the side and bottom insets
 * keep sonner's defaults and the desktop bottom-right toast is unchanged.
 */
const BELOW_HEADER = { top: 64 } as const;

function subscribeCompact(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(COMPACT_VIEWPORT_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function isCompactViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(COMPACT_VIEWPORT_QUERY).matches;
}

/**
 * sonner is used as-is per §7's component inventory ("Standard shadcn/ui
 * components ... Toast/Sonner ... used as-is, restyled through tokens
 * only") — this wrapper supplies the app's resolved theme and maps its
 * CSS-variable hooks onto our tokens instead of sonner's own palette.
 */
export function Toaster() {
  const { resolvedTheme } = useTheme();
  const compact = useSyncExternalStore(subscribeCompact, isCompactViewport, () => false);

  return (
    <SonnerToaster
      theme={resolvedTheme}
      position={compact ? 'top-center' : 'bottom-right'}
      offset={BELOW_HEADER}
      mobileOffset={BELOW_HEADER}
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
