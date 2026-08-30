import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { VisuallyHidden } from '@/components/ui/visually-hidden';
import { CommandPalette } from '@/command-palette/command-palette';
import { NotificationBell } from '@/notifications/notification-bell';
import { AccountMenu } from '@/layout/account-menu';
import { Sidebar } from '@/layout/sidebar';
import { PageIconProvider } from '@/layout/page-chrome';

/**
 * Authenticated app shell (UX_ARCHITECTURE.md §5.3). A left sidebar of
 * collapsible categories carries every section this product ships — the
 * flat top-nav it replaces ran 24 links off the right edge of the screen
 * on anything narrower than a wide desktop. The top bar is now slim: the
 * three global controls §5.3 calls for — the ⌘K command palette (doubling
 * as global search), the notifications bell, and the account/sign-out
 * menu — and, below `md`, a hamburger that opens the same sidebar as a
 * drawer.
 */
export function AppLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex min-h-dvh bg-bg-app">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-sm focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-fg"
      >
        Skip to content
      </a>

      {/* Desktop rail — hidden below md, where the drawer takes over. */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-border-default md:block">
        <Sidebar />
      </aside>

      {/* Mobile drawer — the same Sidebar, closing itself on navigation. */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="p-0">
          <VisuallyHidden>
            <SheetTitle>Navigation</SheetTitle>
          </VisuallyHidden>
          <Sidebar onNavigate={() => setDrawerOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-border-default bg-bg-surface">
          <div className="flex h-14 items-center gap-3 px-4">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Open navigation"
              onClick={() => setDrawerOpen(true)}
            >
              <Menu className="size-5" aria-hidden="true" />
            </Button>

            <div className="ml-auto flex items-center gap-2">
              <CommandPalette />
              <NotificationBell />
              <AccountMenu />
            </div>
          </div>
        </header>

        <main id="main-content" className="flex-1 px-4 py-6 md:px-6">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <PageIconProvider>
              <Outlet />
            </PageIconProvider>
          </div>
        </main>
      </div>
    </div>
  );
}
