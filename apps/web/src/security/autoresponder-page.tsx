import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/error-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ApiClientError, ApiError } from '@/lib/api-client';
import {
  useAutoresponderStatusQuery,
  useUpdateAutoresponderMutation,
} from './use-security-queries';

/**
 * `/security/autoresponder/:user` (FEATURE_MATRIX.md §18). Structured
 * fields only — this form never lets the admin type Sieve; the server
 * generates the `vacation`/`currentdate` script from exactly what is
 * submitted here (`drivers/dms/autoresponder-sieve.ts`).
 */
export function AutoresponderPage() {
  const { user: encodedUser } = useParams<{ user: string }>();
  const user = encodedUser ? decodeURIComponent(encodedUser) : '';

  const statusQuery = useAutoresponderStatusQuery(user);
  const updateMutation = useUpdateAutoresponderMutation(user);

  const [enabled, setEnabled] = useState(false);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Populate the form from the real, current status exactly once per
  // mailbox — after that, the form is the admin's own in-progress edit and
  // must not be silently overwritten by a background refetch.
  useEffect(() => {
    if (statusQuery.data && !hydrated) {
      setEnabled(statusQuery.data.enabled);
      setSubject(statusQuery.data.subject ?? '');
      setMessage(statusQuery.data.message ?? '');
      setStartDate(statusQuery.data.startDate ?? '');
      setEndDate(statusQuery.data.endDate ?? '');
      setHydrated(true);
    }
  }, [statusQuery.data, hydrated]);

  if (statusQuery.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Autoresponder" description={user} />
        <ErrorState
          message="Could not load the autoresponder."
          errorId={
            statusQuery.error instanceof ApiError || statusQuery.error instanceof ApiClientError
              ? statusQuery.error.errorId
              : 'unknown'
          }
          onRetry={() => void statusQuery.refetch()}
        />
      </div>
    );
  }

  if (statusQuery.isLoading || !statusQuery.data) {
    return <Skeleton className="h-96 w-full" />;
  }

  const handleSave = () => {
    setFormError(null);
    if (subject.trim().length === 0 || message.trim().length === 0) {
      setFormError('Subject and message are both required, even while disabled.');
      return;
    }
    if (startDate && endDate && startDate > endDate) {
      setFormError('The start date must be on or before the end date.');
      return;
    }

    updateMutation.mutate(
      {
        enabled,
        subject: subject.trim(),
        message,
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
      },
      {
        onSuccess: () => toast.success(enabled ? 'Autoresponder enabled' : 'Autoresponder saved'),
        onError: (err) => {
          setFormError(err instanceof ApiError ? err.message : 'Could not save the autoresponder.');
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Autoresponder" description={user} />

      {statusQuery.data.unrecognisedContent ? (
        <div className="flex items-start gap-2 rounded-sm border border-status-warning-fg/30 bg-status-warning-bg px-3 py-2 text-body-sm text-status-warning-fg">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            The reserved autoresponder script exists but was changed outside this form (e.g. via the
            Sieve page) and no longer matches what this form generates. Saving below replaces it
            with a script built from the fields here.
          </span>
        </div>
      ) : null}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-body font-semibold">Out of office</CardTitle>
          <div className="flex items-center gap-2">
            <Label htmlFor="autoresponder-enabled" className="text-body-sm">
              {enabled ? 'Enabled' : 'Disabled'}
            </Label>
            <Switch id="autoresponder-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="autoresponder-subject">Subject</Label>
            <Input
              id="autoresponder-subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              maxLength={255}
              placeholder="Out of office"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="autoresponder-message">Message</Label>
            <Textarea
              id="autoresponder-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={10_000}
              className="min-h-40"
              placeholder="I am away and will respond when I return."
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="autoresponder-start">Start date (optional)</Label>
              <Input
                id="autoresponder-start"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="autoresponder-end">End date (optional)</Label>
              <Input
                id="autoresponder-end"
                type="date"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
              />
            </div>
          </div>
          <p className="text-caption text-text-muted">
            Leaving both dates blank responds indefinitely while enabled. A date window is enforced
            with a real Sieve <code className="font-mono-sm">currentdate</code> test, not just a
            UI-side check.
          </p>

          {formError ? <p className="text-body-sm text-status-critical-fg">{formError}</p> : null}

          <div>
            <Button
              type="button"
              variant="primary"
              pending={updateMutation.isPending}
              onClick={handleSave}
            >
              <Save className="size-3.5" aria-hidden="true" />
              Save
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
