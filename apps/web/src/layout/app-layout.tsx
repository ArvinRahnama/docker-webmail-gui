import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LayoutDashboard, LogOut, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLogoutMutation, useSessionQuery } from '@/auth/use-session';
import { CommandPalette } from '@/command-palette/command-palette';
import { NotificationBell } from '@/notifications/notification-bell';
import { cn } from '@/lib/cn';

/**
 * Authenticated app shell: a top nav bar for every section this product
 * ships, plus the session's admin identity, sign-out, and — as of M11 —
 * the three real topbar pieces UX_ARCHITECTURE.md §5.3 calls for that did
 * not exist until now: the command palette (`⌘K`, doubling as global
 * search), and the notifications bell. **Still not** §5.3's full app
 * shell in one other respect: a collapsible 248px sidebar rather than
 * this flat top nav, and no job tray or global status strip yet — a
 * visual restructure independent of M11's actual scope (dashboard,
 * palette, search, notifications), tracked as follow-up work rather than
 * silently done here.
 */
const MAIL_NAV_ITEMS = [
  { to: '/mail/domains', label: 'Domains' },
  { to: '/mail/mailboxes', label: 'Mailboxes' },
  { to: '/mail/aliases', label: 'Aliases' },
  { to: '/mail/storage', label: 'Storage' },
] as const;

// M8 — security surface (FEATURE_MATRIX.md §10-§18). Grows alongside
// this nav bar's own documented "not the real §5.3 shell yet" caveat
// above, same reasoning as MAIL_NAV_ITEMS.
const SECURITY_NAV_ITEMS = [
  { to: '/security/email-auth', label: 'Email Auth' },
  { to: '/security/tls', label: 'TLS' },
  { to: '/security/clamav', label: 'ClamAV' },
  { to: '/security/fail2ban', label: 'Fail2ban' },
  { to: '/security/sieve', label: 'Sieve' },
  { to: '/security/autoresponder', label: 'Autoresponder' },
] as const;

// M9 — Docker & observability (FEATURE_MATRIX.md §24-26, §32). Same
// "not the real §5.3 shell yet" caveat as the two nav groups above.
const DOCKER_NAV_ITEMS = [
  { to: '/docker/containers', label: 'Containers' },
  { to: '/docker/images', label: 'Images' },
  { to: '/docker/volumes', label: 'Volumes' },
  { to: '/docker/networks', label: 'Networks' },
  { to: '/docker/logs', label: 'Logs' },
  { to: '/docker/monitoring', label: 'Monitoring' },
  { to: '/docker/health', label: 'Health' },
  { to: '/docker/console', label: 'Console' },
] as const;

// M10 — Maintenance (FEATURE_MATRIX.md §27-30). Same caveat again: the
// §5.3 sidebar groups these under one "Maintenance" heading; a fourth flat
// nav row is the honest interim, not a claim that the shell is finished.
const MAINTENANCE_NAV_ITEMS = [
  { to: '/maintenance/jobs', label: 'Jobs' },
  { to: '/maintenance/backups', label: 'Backups' },
  { to: '/maintenance/updates', label: 'Updates' },
  { to: '/maintenance/config', label: 'Configuration' },
] as const;

export function AppLayout() {
  const navigate = useNavigate();
  const session = useSessionQuery();
  const logoutMutation = useLogoutMutation();

  return (
    <div className="flex min-h-dvh flex-col bg-bg-app">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-sm focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-fg"
      >
        Skip to content
      </a>

      <header className="border-b border-border-default bg-bg-surface">
        <div className="flex h-13 items-center gap-6 px-4">
          <div className="flex items-center gap-2 font-semibold text-text-primary">
            <Mail className="size-5 text-accent" aria-hidden="true" />
            <span>Docker Webmail GUI</span>
          </div>

          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              cn(
                'flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-body-sm font-medium transition-colors duration-fast',
                isActive
                  ? 'bg-accent-subtle-bg text-accent'
                  : 'text-text-secondary hover:bg-bg-inset hover:text-text-primary',
              )
            }
          >
            <LayoutDashboard className="size-3.5" aria-hidden="true" />
            Dashboard
          </NavLink>

          <div className="h-5 w-px bg-border-default" aria-hidden="true" />

          <nav aria-label="Mail" className="flex items-center gap-1">
            {MAIL_NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'rounded-sm px-3 py-1.5 text-body-sm font-medium transition-colors duration-fast',
                    isActive
                      ? 'bg-accent-subtle-bg text-accent'
                      : 'text-text-secondary hover:bg-bg-inset hover:text-text-primary',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="h-5 w-px bg-border-default" aria-hidden="true" />

          <nav aria-label="Security" className="flex items-center gap-1">
            {SECURITY_NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'rounded-sm px-3 py-1.5 text-body-sm font-medium transition-colors duration-fast',
                    isActive
                      ? 'bg-accent-subtle-bg text-accent'
                      : 'text-text-secondary hover:bg-bg-inset hover:text-text-primary',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="h-5 w-px bg-border-default" aria-hidden="true" />

          <nav aria-label="Docker" className="flex items-center gap-1">
            {DOCKER_NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'rounded-sm px-3 py-1.5 text-body-sm font-medium transition-colors duration-fast',
                    isActive
                      ? 'bg-accent-subtle-bg text-accent'
                      : 'text-text-secondary hover:bg-bg-inset hover:text-text-primary',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="h-5 w-px bg-border-default" aria-hidden="true" />

          <nav aria-label="Maintenance" className="flex items-center gap-1">
            {MAINTENANCE_NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'rounded-sm px-3 py-1.5 text-body-sm font-medium transition-colors duration-fast',
                    isActive
                      ? 'bg-accent-subtle-bg text-accent'
                      : 'text-text-secondary hover:bg-bg-inset hover:text-text-primary',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <CommandPalette />
            <NotificationBell />
            {session.data ? (
              <span className="text-body-sm text-text-secondary">{session.data.admin.email}</span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              pending={logoutMutation.isPending}
              onClick={() =>
                logoutMutation.mutate(undefined, {
                  onSuccess: () => navigate('/login', { replace: true }),
                })
              }
            >
              <LogOut className="size-3.5" aria-hidden="true" />
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main id="main-content" className="flex-1 px-4 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
