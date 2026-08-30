import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Archive,
  BadgeCheck,
  Ban,
  Box,
  Bug,
  Container,
  Database,
  Filter,
  Forward,
  Globe,
  HardDrive,
  HeartPulse,
  Layers,
  LayoutDashboard,
  ListChecks,
  ListOrdered,
  Lock,
  Mail,
  Mailbox,
  Network,
  RefreshCw,
  Reply,
  ScrollText,
  Settings,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
  Wrench,
} from 'lucide-react';

/**
 * The single source of truth for the app's navigation — consumed by both
 * the sidebar (`sidebar.tsx`) and the command palette
 * (`command-palette.tsx` re-exports `NAV_GROUPS` so its
 * `command-palette.route-coverage.test.ts` still imports it from the same
 * path). Every list-level (non-`:param`) route in `App.tsx`'s
 * `<Route element={<AppLayout />}>` block appears here exactly once; that
 * test asserts the claim in both directions, so a new page added to
 * `App.tsx` without an entry here fails the build rather than going
 * quietly unreachable from the nav.
 *
 * Each entry and each section carries a `lucide-react` icon. Icons are a
 * design decision, not decoration bolted on per-call-site: keeping them in
 * this one table means the sidebar, the palette and anything else that
 * renders a nav item all show the same glyph for the same destination.
 */
export interface NavEntry {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

export interface NavGroup {
  readonly heading: string;
  /** The section's own icon, shown on its collapsible header in the sidebar. */
  readonly icon: LucideIcon;
  readonly items: readonly NavEntry[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    heading: 'Overview',
    icon: LayoutDashboard,
    items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    heading: 'Mail',
    icon: Mail,
    items: [
      { to: '/mail/domains', label: 'Domains', icon: Globe },
      { to: '/mail/mailboxes', label: 'Mailboxes', icon: Mailbox },
      { to: '/mail/aliases', label: 'Aliases', icon: Forward },
      { to: '/mail/storage', label: 'Storage', icon: HardDrive },
      { to: '/mail/queue', label: 'Queue', icon: ListOrdered },
    ],
  },
  {
    heading: 'Security',
    icon: ShieldCheck,
    items: [
      { to: '/security/email-auth', label: 'Email Authentication', icon: BadgeCheck },
      { to: '/security/tls', label: 'TLS', icon: Lock },
      { to: '/security/rspamd', label: 'Rspamd', icon: ShieldAlert },
      { to: '/security/clamav', label: 'ClamAV', icon: Bug },
      { to: '/security/fail2ban', label: 'Fail2ban', icon: Ban },
      { to: '/security/sieve', label: 'Sieve', icon: Filter },
      { to: '/security/autoresponder', label: 'Autoresponder', icon: Reply },
    ],
  },
  {
    heading: 'Docker',
    icon: Container,
    items: [
      { to: '/docker/containers', label: 'Containers', icon: Box },
      { to: '/docker/images', label: 'Images', icon: Layers },
      { to: '/docker/volumes', label: 'Volumes', icon: Database },
      { to: '/docker/networks', label: 'Networks', icon: Network },
      { to: '/docker/logs', label: 'Logs', icon: ScrollText },
      { to: '/docker/monitoring', label: 'Monitoring', icon: Activity },
      { to: '/docker/health', label: 'Health', icon: HeartPulse },
      { to: '/docker/console', label: 'Console', icon: SquareTerminal },
    ],
  },
  {
    heading: 'Maintenance',
    icon: Wrench,
    items: [
      { to: '/maintenance/jobs', label: 'Jobs', icon: ListChecks },
      { to: '/maintenance/backups', label: 'Backups', icon: Archive },
      { to: '/maintenance/updates', label: 'Updates', icon: RefreshCw },
      { to: '/maintenance/config', label: 'Configuration', icon: Settings },
    ],
  },
];
