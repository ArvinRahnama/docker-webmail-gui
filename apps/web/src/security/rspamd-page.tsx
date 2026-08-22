/**
 * `/security/rspamd` (M12 gap-closing — RspamdService, rspamd.routes.ts
 * and rspamd-sampler.ts all shipped in M8 with no UI reaching them at
 * all; FEATURE_MATRIX.md §13-15). Scoped to exactly what M8's backend
 * supports and SECURITY.md §3.13 allows: live statistics, action
 * thresholds, per-symbol scores, and the two learn-spam/learn-ham
 * training calls. **There is no config editor here, and there will not
 * be one** — Rspamd's real config embeds Lua and its maps fetch URLs
 * (code execution + SSRF, AGENT_BRIEF.md §4), so only this narrow,
 * named allowlist is exposed, mirroring exactly what the backend already
 * refuses to go beyond (`SetRspamdActionThresholdRequestSchema`/
 * `SetRspamdSymbolScoreRequestSchema` are the only writes; there is no
 * schema anywhere for a raw document).
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { Ban, GraduationCap } from 'lucide-react';
import type { RspamdActionThreshold, RspamdSymbol } from '@dwg/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/status/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { UnsupportedNotice } from '@/components/unsupported-notice';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import {
  useLearnRspamdHamMutation,
  useLearnRspamdSpamMutation,
  useRspamdStatusQuery,
  useRspamdTrendQuery,
  useSetRspamdActionThresholdMutation,
  useSetRspamdSymbolScoreMutation,
} from './use-security-queries';

/** A name + current score + an inline, only-enabled-when-changed Save — reused for both action thresholds and symbol scores, the two rows FEATURE_MATRIX.md §15 allows editing at all. */
function EditableScoreRow({
  name,
  score,
  pending,
  onSave,
}: {
  readonly name: string;
  readonly score: number | null;
  readonly pending: boolean;
  readonly onSave: (score: number) => void;
}) {
  const [value, setValue] = useState(score === null ? '' : String(score));
  const parsed = Number(value);
  const isValid = value.trim().length > 0 && Number.isFinite(parsed);
  const changed = isValid && parsed !== score;

  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label={`Score for ${name}`}
        type="number"
        step="0.1"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="w-24"
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={!changed}
        pending={pending}
        onClick={() => onSave(parsed)}
      >
        Save
      </Button>
    </div>
  );
}

function ActionThresholdsCard({ actions }: { readonly actions: readonly RspamdActionThreshold[] }) {
  const mutation = useSetRspamdActionThresholdMutation();
  const [savingAction, setSavingAction] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-body font-semibold">Action thresholds</CardTitle>
        <p className="text-caption text-text-muted">
          The score at which each action fires. The only write here is a single named action&apos;s
          threshold — never a full config document.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {actions.length === 0 ? (
          <p className="text-body-sm text-text-secondary">No action thresholds reported.</p>
        ) : (
          actions.map((entry) => (
            <div key={entry.action} className="flex items-center justify-between gap-3">
              <span className="text-body-sm font-medium text-text-primary">{entry.action}</span>
              <EditableScoreRow
                name={entry.action}
                score={entry.score}
                pending={mutation.isPending && savingAction === entry.action}
                onSave={(score) => {
                  setSavingAction(entry.action);
                  mutation.mutate(
                    { action: entry.action, score },
                    {
                      onSuccess: () => toast.success(`Updated threshold for ${entry.action}`),
                      onError: () => toast.error(`Could not update ${entry.action}`),
                      onSettled: () => setSavingAction(null),
                    },
                  );
                }}
              />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function SymbolScoresCard({ symbols }: { readonly symbols: readonly RspamdSymbol[] }) {
  const mutation = useSetRspamdSymbolScoreMutation();
  const [savingSymbol, setSavingSymbol] = useState<string | null>(null);

  const columns: DataTableColumn<RspamdSymbol>[] = [
    { id: 'name', header: 'Symbol', sortValue: (row) => row.name, cell: (row) => row.name },
    {
      id: 'group',
      header: 'Group',
      sortValue: (row) => row.group ?? '',
      cell: (row) => row.group ?? '—',
    },
    {
      id: 'description',
      header: 'Description',
      cell: (row) => row.description ?? '—',
    },
    {
      id: 'score',
      header: 'Score',
      sortValue: (row) => row.score,
      cell: (row) => (
        <EditableScoreRow
          name={row.name}
          score={row.score}
          pending={mutation.isPending && savingSymbol === row.name}
          onSave={(score) => {
            setSavingSymbol(row.name);
            mutation.mutate(
              { symbol: row.name, score },
              {
                onSuccess: () => toast.success(`Updated score for ${row.name}`),
                onError: () => toast.error(`Could not update ${row.name}`),
                onSettled: () => setSavingSymbol(null),
              },
            );
          }}
        />
      ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-body font-semibold">Symbol scores</CardTitle>
      </CardHeader>
      <CardContent>
        <DataTable
          data={symbols}
          columns={columns}
          getRowId={(row) => row.name}
          caption="Rspamd symbol scores"
          initialSort={{ id: 'name', desc: false }}
          emptyState={
            <EmptyState
              variant="first-run"
              title="No symbols reported"
              description="Rspamd has not reported any scored symbols yet."
            />
          }
        />
      </CardContent>
    </Card>
  );
}

export function RspamdPage() {
  const statusQuery = useRspamdStatusQuery();
  const trendQuery = useRspamdTrendQuery();
  const learnSpamMutation = useLearnRspamdSpamMutation();
  const learnHamMutation = useLearnRspamdHamMutation();
  const [learnMessage, setLearnMessage] = useState('');
  const [pendingLearn, setPendingLearn] = useState<'spam' | 'ham' | null>(null);

  if (statusQuery.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Rspamd" description="Spam filtering — statistics and scoring." />
        <ErrorState
          message="Could not load Rspamd status."
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
    return <Skeleton className="h-64 w-full" />;
  }

  const status = statusQuery.data;

  if (!status.capability.supported) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Rspamd" description="Spam filtering — statistics and scoring." />
        <UnsupportedNotice
          reason={status.capability.reason ?? 'Rspamd is unsupported on this deployment.'}
          docsHref="https://docker-mailserver.github.io/docker-mailserver/latest/config/security/rspamd/"
        />
      </div>
    );
  }

  const trend = trendQuery.data;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Rspamd"
        description="Spam filtering — live statistics, action thresholds, symbol scores, and Bayes training."
      />

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-body font-semibold">Controller</CardTitle>
          <StatusBadge status={status.reachable ? 'healthy' : 'critical'} />
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-body-sm">
          {!status.reachable ? (
            <p className="text-text-muted">
              {status.error ?? 'The Rspamd controller is not reachable.'}
            </p>
          ) : status.stat === null ? (
            <p className="text-text-muted">No statistics reported.</p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
                <div className="flex flex-col">
                  <dt className="text-caption text-text-muted">Scanned</dt>
                  <dd className="text-h2 font-semibold text-text-primary">
                    {status.stat.scanned ?? 'Unknown'}
                  </dd>
                </div>
                <div className="flex flex-col">
                  <dt className="text-caption text-text-muted">Learned</dt>
                  <dd className="text-h2 font-semibold text-text-primary">
                    {status.stat.learned ?? 'Unknown'}
                  </dd>
                </div>
                <div className="flex flex-col">
                  <dt className="text-caption text-text-muted">Ham</dt>
                  <dd className="text-h2 font-semibold text-text-primary">
                    {status.stat.hamCount ?? 'Unknown'}
                  </dd>
                </div>
                <div className="flex flex-col">
                  <dt className="text-caption text-text-muted">Spam</dt>
                  <dd className="text-h2 font-semibold text-text-primary">
                    {status.stat.spamCount ?? 'Unknown'}
                  </dd>
                </div>
              </dl>

              {Object.keys(status.stat.actions).length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-secondary">
                  {Object.entries(status.stat.actions).map(([action, count]) => (
                    <span key={action}>
                      {action}: <span className="font-medium text-text-primary">{count}</span>
                    </span>
                  ))}
                </div>
              ) : null}

              <p className="mt-2 text-caption text-text-muted">
                {trend === undefined
                  ? 'Loading trend…'
                  : trend.collecting
                    ? `Collecting — trend available after ${trend.windowHours}h of our own sampling.`
                    : `${trend.points.length} sample(s) over the trailing ${trend.windowHours}h. Most recent: ${trend.points[trend.points.length - 1]?.value ?? 'Unknown'} (${formatDateTime(trend.points[trend.points.length - 1]?.sampledAt ?? null)}).`}
              </p>
              <p className="text-caption text-text-muted">{status.historyCaveat}</p>
            </>
          )}
        </CardContent>
      </Card>

      {status.reachable ? (
        <>
          <ActionThresholdsCard actions={status.actions} />
          <SymbolScoresCard symbols={status.symbols} />

          <Card>
            <CardHeader>
              <CardTitle className="text-body font-semibold">Train Bayes</CardTitle>
              <p className="text-caption text-text-muted">
                Learning a message is a real, permanent effect on future scoring — confirmed before
                it is sent, and audited every time.
              </p>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rspamd-learn-message">Message (raw, including headers)</Label>
                <Textarea
                  id="rspamd-learn-message"
                  value={learnMessage}
                  onChange={(event) => setLearnMessage(event.target.value)}
                  rows={8}
                  placeholder="Paste a full raw message…"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={learnMessage.trim().length === 0}
                  onClick={() => setPendingLearn('spam')}
                >
                  <Ban className="size-3.5" aria-hidden="true" />
                  Learn as spam
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={learnMessage.trim().length === 0}
                  onClick={() => setPendingLearn('ham')}
                >
                  <GraduationCap className="size-3.5" aria-hidden="true" />
                  Learn as ham
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}

      <ConfirmDialog
        open={pendingLearn !== null}
        onOpenChange={(open) => {
          if (!open) setPendingLearn(null);
        }}
        tier={2}
        title={`Learn this message as ${pendingLearn ?? ''}?`}
        description="This permanently affects how Rspamd scores similar future messages. It cannot be selectively undone."
        confirmLabel="Learn"
        pending={learnSpamMutation.isPending || learnHamMutation.isPending}
        onConfirm={() => {
          const message = learnMessage;
          const mutation = pendingLearn === 'spam' ? learnSpamMutation : learnHamMutation;
          const label = pendingLearn;
          mutation.mutate(message, {
            onSuccess: () => {
              setPendingLearn(null);
              setLearnMessage('');
              toast.success(`Learned as ${label}`);
            },
            onError: () => toast.error('Could not learn this message'),
          });
        }}
      />
    </div>
  );
}
