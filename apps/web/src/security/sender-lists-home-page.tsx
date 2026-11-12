import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MailboxPicker } from './mailbox-picker';
import { SenderReportsTable } from './sender-reports-table';
import { SpamIntegrationNotice } from './spam-integration-notice';
import { useSenderReportsQuery, useSpamIntegrationQuery } from './use-security-queries';

/** `/security/sender-lists` — pick a mailbox; below, every mailbox's recent spam / not-spam reports. */
export function SenderListsHomePage() {
  const integration = useSpamIntegrationQuery();
  const reports = useSenderReportsQuery(null);

  return (
    <MailboxPicker
      title="Sender Lists"
      description="Each mailbox's own allowed and blocked senders. Allowed senders never land in Junk; blocked senders always do."
      destinationPrefix="/security/sender-lists"
      notice={<SpamIntegrationNotice integration={integration.data} />}
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-body font-semibold">Recent reports from users</CardTitle>
          <p className="text-caption text-text-muted">
            A user moving mail out of Junk allows the sender; moving mail into Junk blocks it. For
            shared providers such as Gmail, and for this server's own domains, only that one address
            is listed — never the whole domain.
          </p>
        </CardHeader>
        <CardContent>
          <SenderReportsTable
            reports={reports.data ?? []}
            isLoading={reports.isLoading}
            showMailbox
          />
        </CardContent>
      </Card>
    </MailboxPicker>
  );
}
