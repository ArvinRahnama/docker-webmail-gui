import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { NAV_GROUPS } from '@/layout/nav-config';

/**
 * Resolves the icon a page should show in its header from the current
 * route, using the same `NAV_GROUPS` table the sidebar draws from — so a
 * section's glyph is identical in the nav and on the page it leads to,
 * from one source. Detail routes (`/mail/mailboxes/:address`) resolve to
 * their list section's icon by longest-matching prefix.
 */
function iconForPath(pathname: string): LucideIcon | null {
  let best: { length: number; icon: LucideIcon } | null = null;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      const matches = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
      if (matches && (best === null || item.to.length > best.length)) {
        best = { length: item.to.length, icon: item.icon };
      }
    }
  }
  return best?.icon ?? null;
}

const PageIconContext = createContext<LucideIcon | null>(null);

/**
 * Provides the current route's section icon to any `PageHeader` rendered
 * beneath it. Lives at the app-shell level (`app-layout.tsx`), so the
 * icon follows navigation without any page having to name it. A page
 * rendered outside this provider — including a component test that mounts
 * a page bare — sees `null` and simply shows no header icon, so nothing
 * depends on the router being present.
 */
export function PageIconProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const icon = useMemo(() => iconForPath(pathname), [pathname]);
  return <PageIconContext.Provider value={icon}>{children}</PageIconContext.Provider>;
}

export function useResolvedPageIcon(): LucideIcon | null {
  return useContext(PageIconContext);
}
