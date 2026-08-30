import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import type { NavEntry, NavGroup } from '@/layout/nav-config';
import { NAV_GROUPS } from '@/layout/nav-config';
import { BrandMark } from '@/components/brand-mark';
import { cn } from '@/lib/cn';

/** True when `pathname` is `to` or a descendant of it — `/` matches only itself, so the dashboard never lights up under every route. */
function isActivePath(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/';
  return pathname === to || pathname.startsWith(`${to}/`);
}

const itemLinkClass = (isActive: boolean) =>
  cn(
    'flex items-center gap-2.5 rounded-md px-3 py-2 text-body-sm font-medium transition-colors duration-fast ease-standard',
    isActive
      ? 'bg-accent-subtle-bg text-accent'
      : 'text-text-secondary hover:bg-bg-inset hover:text-text-primary',
  );

function NavItemLink({
  item,
  onNavigate,
}: {
  item: NavEntry;
  onNavigate?: (() => void) | undefined;
}) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      onClick={onNavigate}
      className={({ isActive }) => itemLinkClass(isActive)}
    >
      {({ isActive }) => (
        <>
          <Icon
            className={cn('size-4 shrink-0', isActive ? 'text-accent' : 'text-text-muted')}
            aria-hidden="true"
          />
          <span className="truncate">{item.label}</span>
        </>
      )}
    </NavLink>
  );
}

/**
 * One collapsible category. The `<nav aria-label={heading}>` wraps both
 * the toggle and the list, so the landmark stays visible (and keeps its
 * accessible name) even while the section is collapsed — several E2E
 * specs use `getByRole('navigation', { name: 'Mail' })` as the "shell is
 * loaded" sentinel, and a collapsed section must not make it disappear.
 *
 * A single-item group (Overview → Dashboard) has no toggle: it renders as
 * a plain link, since there is nothing to collapse.
 */
function NavSection({
  group,
  onNavigate,
}: {
  group: NavGroup;
  onNavigate?: (() => void) | undefined;
}) {
  const { pathname } = useLocation();
  const containsActive = group.items.some((item) => isActivePath(pathname, item.to));

  if (group.items.length === 1) {
    return (
      <nav aria-label={group.heading}>
        <NavItemLink item={group.items[0]!} onNavigate={onNavigate} />
      </nav>
    );
  }

  return <CollapsibleSection group={group} defaultOpen={containsActive} onNavigate={onNavigate} />;
}

function CollapsibleSection({
  group,
  defaultOpen,
  onNavigate,
}: {
  group: NavGroup;
  defaultOpen: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(defaultOpen);
  const listId = `nav-section-${group.heading.toLowerCase()}`;
  const SectionIcon = group.icon;

  // Navigating into this section (via the palette, a link elsewhere, or a
  // browser back/forward) opens it, so the active route is never hidden
  // inside a collapsed group. Deliberately one-way: it never force-closes
  // a section the admin opened, only opens the one they landed in.
  useEffect(() => {
    if (group.items.some((item) => isActivePath(pathname, item.to))) setOpen(true);
  }, [pathname, group.items]);

  return (
    <nav aria-label={group.heading} className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-2.5 rounded-md px-3 py-2 text-caption font-semibold uppercase tracking-wide text-text-muted transition-colors duration-fast ease-standard hover:bg-bg-inset hover:text-text-secondary"
      >
        <SectionIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 text-left">{group.heading}</span>
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 transition-transform duration-base ease-standard',
            open ? 'rotate-180' : 'rotate-0',
          )}
          aria-hidden="true"
        />
      </button>
      <ul id={listId} hidden={!open} className="mt-0.5 flex flex-col gap-0.5 pl-2">
        {group.items.map((item) => (
          <li key={item.to}>
            <NavItemLink item={item} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The primary navigation surface. Rendered as a fixed rail on desktop
 * (`app-layout.tsx` hides it below `md`) and inside the mobile drawer;
 * `onNavigate` lets the drawer close itself when a link is chosen.
 */
export function Sidebar({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  return (
    <div className="flex h-full flex-col bg-bg-surface">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border-subtle px-4 font-semibold text-text-primary">
        <BrandMark className="h-9" />
        <span className="truncate">Docker Webmail GUI</span>
      </div>
      <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-4">
        {NAV_GROUPS.map((group) => (
          <NavSection key={group.heading} group={group} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  );
}
