import { cn } from '@/lib/cn';
import { STATUS_META, type Status } from './status';

export interface HealthIndicatorProps {
  readonly status: Status;
  /** Overrides the default state word. */
  readonly label?: string;
  /**
   * When `false`, the word is still present for assistive tech (a
   * visually-hidden span, so the accessible name always "carries the
   * state word" per §7) but not rendered visually — for compact contexts
   * like a table cell that also has its own adjacent text column.
   */
  readonly showLabel?: boolean;
  readonly className?: string;
}

/** Inline dot + label (§7). Renders the status icon (see status.ts for why an icon rather than a literal CSS dot) at a small size next to the state word. */
export function HealthIndicator({
  status,
  label,
  showLabel = true,
  className,
}: HealthIndicatorProps) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  const text = label ?? meta.label;

  return (
    <span className={cn('inline-flex items-center gap-1.5', meta.fgClassName, className)}>
      <Icon className={cn('size-3.5 shrink-0', meta.spin && 'animate-spin')} aria-hidden="true" />
      <span className={cn('text-body-sm', !showLabel && 'sr-only')}>{text}</span>
    </span>
  );
}
