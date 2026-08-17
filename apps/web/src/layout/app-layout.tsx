import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LogOut, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLogoutMutation, useSessionQuery } from '@/auth/use-session';
import { cn } from '@/lib/cn';

/**
 * Minimal authenticated app shell: a top nav bar for the mail-management
 * section this milestone ships, plus the session's admin identity and
 * sign-out. **Not** UX_ARCHITECTURE.md §5.3's full app shell (collapsible
 * 248px sidebar, command palette, job tray, global status strip) — that
 * shell spans every section of the product (Security, Docker, Monitoring,
 * Configuration, Maintenance, Administration), none of which exist yet.
 * Building a full sidebar whose other eight nav groups all 404 would be
 * worse than a small, honest nav scoped to what this milestone actually
 * ships. Replacing this with the real shell is tracked as follow-up work,
 * not silently done here.
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

          <div className="ml-auto flex items-center gap-3">
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
