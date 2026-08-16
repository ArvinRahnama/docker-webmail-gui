import type { ReactNode } from 'react';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { STATUS_META } from '@/components/status/status';

export interface MetricTileTrend {
  readonly direction: 'up' | 'down' | 'flat';
  /** e.g. "+12% vs yesterday" — the whole point is a real comparison, not a bare arrow. */
  readonly label: string;
}

export interface MetricTileProps {
  readonly label: string;
  /** Pre-formatted for display (e.g. "1,284", "82%") — this component doesn't own number formatting. */
  readonly value: string | number;
  readonly unit?: string;
  readonly trend?: MetricTileTrend;
  /**
   * §2 principle 2, §6.1: "A metric we cannot source is absent or
   * explicitly Unknown, never estimated ... shows Unknown honestly if its
   * source is unreachable." When true, `value`/`unit`/`trend` are ignored
   * and the tile renders the `unknown` status treatment instead — grey,
   * not alarming (§3.3).
   */
  readonly unknown?: boolean;
  /** Optional small chart, e.g. a recharts sparkline — MetricTile stays chart-library-agnostic and just reserves the slot. */
  readonly sparkline?: ReactNode;
  readonly className?: string;
}

const TREND_ICON = { up: TrendingUp, down: TrendingDown, flat: Minus } as const;

export function MetricTile({
  label,
  value,
  unit,
  trend,
  unknown = false,
  sparkline,
  className,
}: MetricTileProps) {
  const accessibleValue = unknown
    ? `${label}: Unknown`
    : `${label}: ${value}${unit ? ` ${unit}` : ''}${trend ? `, ${trend.label}` : ''}`;

  return (
    <Card className={cn('flex flex-col gap-2 p-4', className)}>
      <span className="text-caption font-medium text-text-muted">{label}</span>

      {/* The numeric value is also expressed as one accessible string on
          this element — §7: "Value in aria-label, not just visual" — so a
          screen reader gets the whole reading in one stop rather than
          piecing together the number, unit and trend arrow separately. */}
      <div aria-label={accessibleValue}>
        {unknown ? (
          <UnknownValue />
        ) : (
          <div className="flex items-baseline gap-1.5" aria-hidden="true">
            <span className="text-display font-semibold tabular-nums text-text-primary">
              {value}
            </span>
            {unit ? <span className="text-body-sm text-text-secondary">{unit}</span> : null}
          </div>
        )}

        {!unknown && trend ? (
          <div
            className={cn(
              'mt-1 flex items-center gap-1 text-body-sm',
              trendColorClassName(trend.direction),
            )}
            aria-hidden="true"
          >
            <TrendIcon direction={trend.direction} />
            <span>{trend.label}</span>
          </div>
        ) : null}
      </div>

      {!unknown && sparkline ? <div className="mt-1">{sparkline}</div> : null}
    </Card>
  );
}

function UnknownValue() {
  const meta = STATUS_META.unknown;
  const Icon = meta.icon;
  return (
    <div className={cn('flex items-center gap-1.5', meta.fgClassName)} aria-hidden="true">
      <Icon className="size-5" aria-hidden="true" />
      <span className="text-h2 font-semibold">Unknown</span>
    </div>
  );
}

function TrendIcon({ direction }: { direction: MetricTileTrend['direction'] }) {
  const Icon = TREND_ICON[direction];
  return <Icon className="size-3.5" aria-hidden="true" />;
}

function trendColorClassName(direction: MetricTileTrend['direction']): string {
  // Trend direction is informational, not itself a status judgement (a
  // rising queue is bad; rising "spam blocked" is good) — deliberately
  // neutral colour here rather than borrowing the status palette, so the
  // caller's own label carries the meaning as text.
  switch (direction) {
    case 'up':
      return 'text-text-secondary';
    case 'down':
      return 'text-text-secondary';
    case 'flat':
      return 'text-text-muted';
  }
}
