import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useMailboxesQuery } from '@/mail/use-mail-queries';

export interface MailboxPickerProps {
  readonly title: string;
  readonly description: string;
  /** Path prefix a selected mailbox is appended to, e.g. `/security/sieve` -> `/security/sieve/<email>`. */
  readonly destinationPrefix: string;
}

/**
 * Shared "pick a mailbox" landing page for the two per-mailbox security
 * features (Sieve scripts, Autoresponder) — both need the identical
 * search-then-select flow, so it lives once here rather than being
 * duplicated per feature (mirrors this app's "one `DataTable`, one
 * `ConfirmDialog`" convention for shared UI shape).
 */
export function MailboxPicker({ title, description, destinationPrefix }: MailboxPickerProps) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const query = useMailboxesQuery({ pageSize: 25, ...(search ? { search } : {}) });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} description={description} />

      <Card>
        <CardHeader>
          <CardTitle className="text-body font-semibold">Choose a mailbox</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search mailboxes by address…"
              className="pl-9"
              aria-label="Search mailboxes"
            />
          </div>

          {query.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : !query.data || query.data.mailboxes.length === 0 ? (
            <EmptyState
              variant="first-run"
              title="No mailboxes found"
              description="Create a mailbox first, then come back here to manage its filters."
            />
          ) : (
            <ul className="flex flex-col divide-y divide-border-subtle rounded-md border border-border-default">
              {query.data.mailboxes.map((mailbox) => (
                <li key={mailbox.email}>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(`${destinationPrefix}/${encodeURIComponent(mailbox.email)}`)
                    }
                    className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-body-sm text-text-primary transition-colors duration-fast hover:bg-bg-inset"
                  >
                    <span className="font-medium">{mailbox.email}</span>
                    <span className="text-text-muted">{mailbox.domain}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
