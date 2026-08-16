import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/query-client';
import { ThemeProvider } from '@/theme/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { RedirectIfAuthenticated, RequireAuth } from '@/auth/auth-guard';
import { SessionBootstrap } from '@/auth/session-bootstrap';
import { LoginPage } from '@/auth/login-page';
import { ChangePasswordPage } from '@/auth/change-password-page';
import { AppLayout } from '@/layout/app-layout';
import { DomainsListPage } from '@/mail/domains-list-page';
import { DomainDetailPage } from '@/mail/domain-detail-page';
import { MailboxesListPage } from '@/mail/mailboxes-list-page';
import { MailboxDetailPage } from '@/mail/mailbox-detail-page';
import { AliasesPage } from '@/mail/aliases-page';
import { StoragePage } from '@/mail/storage-page';

/**
 * Root component: providers, then routes (milestone brief §5/§6;
 * UX_ARCHITECTURE.md §5.2). `/` and every `/mail/*` route this milestone
 * ships live behind `RequireAuth`. Everything under `Route
 * element={<AppLayout />}` shares the top nav shell; `/change-password`
 * deliberately does not (§6: a forced-password-change admin lands on a
 * standalone page, not the full app chrome).
 */
export default function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <SessionBootstrap />
          <Routes>
            <Route element={<RedirectIfAuthenticated />}>
              <Route path="/login" element={<LoginPage />} />
            </Route>

            <Route element={<RequireAuth />}>
              <Route path="/change-password" element={<ChangePasswordPage />} />

              <Route element={<AppLayout />}>
                <Route path="/" element={<Navigate to="/mail/domains" replace />} />
                <Route path="/mail/domains" element={<DomainsListPage />} />
                <Route path="/mail/domains/:domain" element={<DomainDetailPage />} />
                <Route path="/mail/mailboxes" element={<MailboxesListPage />} />
                <Route path="/mail/mailboxes/:address" element={<MailboxDetailPage />} />
                <Route path="/mail/aliases" element={<AliasesPage />} />
                <Route path="/mail/storage" element={<StoragePage />} />
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
