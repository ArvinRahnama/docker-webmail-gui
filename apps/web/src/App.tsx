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
import { EmailAuthListPage } from '@/security/email-auth-list-page';
import { EmailAuthDetailPage } from '@/security/email-auth-detail-page';
import { TlsPage } from '@/security/tls-page';
import { ClamavPage } from '@/security/clamav-page';
import { Fail2banPage } from '@/security/fail2ban-page';
import { SieveHomePage } from '@/security/sieve-home-page';
import { SieveScriptsPage } from '@/security/sieve-scripts-page';
import { AutoresponderHomePage } from '@/security/autoresponder-home-page';
import { AutoresponderPage } from '@/security/autoresponder-page';
import { ContainersPage } from '@/docker/containers-page';
import { ImagesPage } from '@/docker/images-page';
import { VolumesPage } from '@/docker/volumes-page';
import { NetworksPage } from '@/docker/networks-page';
import { LogsPage } from '@/docker/logs-page';
import { MonitoringPage } from '@/docker/monitoring-page';
import { HealthPage } from '@/docker/health-page';
import { ConsolePage } from '@/docker/console-page';
import { JobsPage, JobDetailPage } from '@/maintenance/jobs-page';
import { BackupsPage } from '@/maintenance/backups-page';
import { UpdatesPage } from '@/maintenance/updates-page';
import { ConfigPage } from '@/maintenance/config-page';

/**
 * Root component: providers, then routes (UX_ARCHITECTURE.md §5.2). `/`
 * and every `/mail/*` route this milestone ships live behind
 * `RequireAuth`. Everything under `Route element={<AppLayout />}` shares
 * the top nav shell; `/change-password` deliberately does not — an admin
 * forced to change their password lands on a standalone page rather than
 * the full app chrome, so the only route out is the one that unblocks
 * them.
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
                <Route path="/security/email-auth" element={<EmailAuthListPage />} />
                <Route path="/security/email-auth/:domain" element={<EmailAuthDetailPage />} />
                <Route path="/security/tls" element={<TlsPage />} />
                <Route path="/security/clamav" element={<ClamavPage />} />
                <Route path="/security/fail2ban" element={<Fail2banPage />} />
                <Route path="/security/sieve" element={<SieveHomePage />} />
                <Route path="/security/sieve/:user" element={<SieveScriptsPage />} />
                <Route path="/security/autoresponder" element={<AutoresponderHomePage />} />
                <Route path="/security/autoresponder/:user" element={<AutoresponderPage />} />
                <Route path="/docker/containers" element={<ContainersPage />} />
                <Route path="/docker/images" element={<ImagesPage />} />
                <Route path="/docker/volumes" element={<VolumesPage />} />
                <Route path="/docker/networks" element={<NetworksPage />} />
                <Route path="/docker/logs" element={<LogsPage />} />
                <Route path="/docker/monitoring" element={<MonitoringPage />} />
                <Route path="/docker/health" element={<HealthPage />} />
                <Route path="/docker/console" element={<ConsolePage />} />
                <Route path="/maintenance/jobs" element={<JobsPage />} />
                <Route path="/maintenance/jobs/:id" element={<JobDetailPage />} />
                <Route path="/maintenance/backups" element={<BackupsPage />} />
                <Route path="/maintenance/updates" element={<UpdatesPage />} />
                <Route path="/maintenance/config" element={<ConfigPage />} />
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
