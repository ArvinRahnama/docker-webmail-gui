import { cn } from '@/lib/cn';
import { STATUS_META, type Status } from './status';

export interface StatusBadgeProps {
  readonly status: Status;
  /**
   * `subtle` (default): tinted background, coloured text/icon — the
   * pairing tokens.contrast.test.ts verifies at >=4.5:1. `solid`: same
   * verified text/icon colour, but on `--bg-surface` with a bold coloured
   * border instead of a tinted fill, for a more emphatic chip (e.g. the
   * dashboard verdict row) without invening a second, unverified
   * text-on-fill colour pairing — §3.3 only publishes fg/bg per state, not
   * a third "text on solid fill" colour.
   */
  readonly variant?: 'subtle' | 'solid';
  /** Overrides the default state word (e.g. "3 problems" instead of "Critical") — still rendered as real text, never icon-only. */
  readonly label?: string;
  readonly className?: string;
}

/** Status as a chip — icon + text always, colour is the last channel (§2, §3.3). */
export function StatusBadge({ status, variant = 'subtle', label, className }: StatusBadgeProps) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-caption font-medium',
        meta.fgClassName,
        variant === 'subtle'
          ? meta.bgClassName
          : cn('border-2 bg-bg-surface', borderClassName(status)),
        className,
      )}
    >
      <Icon className={cn('size-3.5', meta.spin && 'animate-spin')} aria-hidden="true" />
      <span>{label ?? meta.label}</span>
    </span>
  );
}

// Tailwind v4 scans for literal class-name substrings, so this can't be
// built with `border-status-${status}-fg` template interpolation — it has
// to be a real switch over literal strings for the border-color utilities
// to actually be generated.
function borderClassName(status: Status): string {
  switch (status) {
    case 'healthy':
      return 'border-status-healthy-fg';
    case 'warning':
      return 'border-status-warning-fg';
    case 'critical':
      return 'border-status-critical-fg';
    case 'unknown':
      return 'border-status-unknown-fg';
    case 'info':
      return 'border-status-info-fg';
    case 'pending':
      return 'border-status-pending-fg';
  }
}
