import { AlertOctagon, AlertTriangle, CheckCircle2, HelpCircle, Info, Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * The six-state status vocabulary (UX_ARCHITECTURE.md §3.3) — the single
 * source of truth `StatusBadge` and `HealthIndicator` both render from, so
 * the two components can never quietly disagree on an icon, label or
 * colour for the same state.
 *
 * `unknown` is deliberately grey, never yellow/amber — "we could not
 * determine this" is not a warning, and §3.3 calls conflating the two
 * "the single most important colour decision in the product."
 *
 * Both components render the icon (not a plain CSS dot/triangle/octagon)
 * as the shape cue: the six lucide icons below are already visually
 * distinct silhouettes, so leaning on them — rather than also hand-maintaining
 * a second, parallel set of CSS-drawn shapes for HealthIndicator's "dot" —
 * satisfies "icon + shape + text, never colour alone" (§2 principle 5,
 * §3.3) without two systems that could drift apart.
 */
export const STATUS_STATES = [
  'healthy',
  'warning',
  'critical',
  'unknown',
  'info',
  'pending',
] as const;
export type Status = (typeof STATUS_STATES)[number];

export interface StatusMeta {
  readonly icon: LucideIcon;
  readonly label: string;
  /** `pending`'s spinner — CSS `animate-spin`, which index.css's global `prefers-reduced-motion` rule already collapses to a static icon (§4). */
  readonly spin: boolean;
  readonly fgClassName: string;
  readonly bgClassName: string;
}

export const STATUS_META: Readonly<Record<Status, StatusMeta>> = {
  healthy: {
    icon: CheckCircle2,
    label: 'Healthy',
    spin: false,
    fgClassName: 'text-status-healthy-fg',
    bgClassName: 'bg-status-healthy-bg',
  },
  warning: {
    icon: AlertTriangle,
    label: 'Warning',
    spin: false,
    fgClassName: 'text-status-warning-fg',
    bgClassName: 'bg-status-warning-bg',
  },
  critical: {
    icon: AlertOctagon,
    label: 'Critical',
    spin: false,
    fgClassName: 'text-status-critical-fg',
    bgClassName: 'bg-status-critical-bg',
  },
  unknown: {
    icon: HelpCircle,
    label: 'Unknown',
    spin: false,
    fgClassName: 'text-status-unknown-fg',
    bgClassName: 'bg-status-unknown-bg',
  },
  info: {
    icon: Info,
    label: 'Info',
    spin: false,
    fgClassName: 'text-status-info-fg',
    bgClassName: 'bg-status-info-bg',
  },
  pending: {
    icon: Loader2,
    label: 'Pending',
    spin: true,
    fgClassName: 'text-status-pending-fg',
    bgClassName: 'bg-status-pending-bg',
  },
};
