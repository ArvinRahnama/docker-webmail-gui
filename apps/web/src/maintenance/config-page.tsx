/**
 * `/maintenance/config` (M10 — FEATURE_MATRIX.md §28-29). The milestone
 * fixes the flow: validate → diff → explain restart/recreate impact →
 * confirm → apply → verify → audit. This page owns the first four; the
 * server owns apply/verify/audit and re-runs validation itself, so nothing
 * here is a security boundary — it is the explanation an admin needs
 * *before* the boundary is reached.
 *
 * Three decisions worth stating:
 *
 *  - **Nothing is sent while typing.** Edits accumulate locally, and the
 *    only way to reach `apply` is through `validate`, so the diff an admin
 *    confirms is the diff the server produced, never one this page guessed
 *    from its own copy of the rules.
 *  - **Secrets stay masked until asked for.** Revealing is an audited
 *    `POST` (SECURITY.md §7.6), so it is a button, never something a page
 *    load or a cache refetch can trigger. Editing a secret does not
 *    require revealing it first — typing a new value is not reading the
 *    old one.
 *  - **Applying does not claim to take effect.** Every editable setting is
 *    `needs-restart` today, and `config.service.ts` is explicit that apply
 *    persists intent rather than changing the running process. The success
 *    message says exactly that instead of implying a live change.
 */
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Eye, RotateCcw } from 'lucide-react';
import type {
  ConfigChangeSet,
  ConfigChangeValidation,
  ConfigSetting,
  ConfigSettingClassification,
  ConfigSnapshotSummary,
  ValidateConfigResponse,
} from '@dwg/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { ServerControls } from './server-controls';
import {
  useApplyConfigMutation,
  useConfigSettingsQuery,
  useConfigSnapshotsQuery,
  useRevealConfigSettingMutation,
  useRollbackConfigMutation,
  useValidateConfigMutation,
} from './use-maintenance-queries';

function errorIdOf(error: unknown): string {
  return error instanceof ApiError || error instanceof ApiClientError ? error.errorId : 'unknown';
}

function errorMessageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof ApiClientError ? error.message : fallback;
}

/**
 * `CONFIG_SETTING_CLASSIFICATIONS` is a closed set, so this record is
 * exhaustive by construction — adding a classification upstream will not
 * compile until it is described here.
 */
const CLASSIFICATION_LABELS: Readonly<Record<ConfigSettingClassification, string>> = {
  'read-only': 'Read-only',
  'editable-live': 'Takes effect immediately',
  'needs-restart': 'Needs a restart',
  'needs-recreate': 'Needs the container recreated',
};

/**
 * What an admin has to *do* after applying, in one sentence. Deliberately
 * phrased as consequence rather than category: "needs-restart" names a
 * classification, "the panel must be restarted" names the work.
 */
const IMPACT_SENTENCES: Readonly<Record<ConfigSettingClassification, string>> = {
  'read-only': 'This setting cannot be changed from the panel.',
  'editable-live': 'This takes effect as soon as it is applied.',
  'needs-restart':
    'The panel keeps running with its current values until it is restarted — applying stores the change, it does not activate it.',
  'needs-recreate':
    'This needs the container recreated, which the broker cannot do. Applying stores the change; activating it is a manual step on the host.',
};

/** A value that is `null` is unset or masked; either way it is prose, not an empty cell. */
function CurrentValue({ setting }: { readonly setting: ConfigSetting }) {
  if (setting.masked) {
    return <span className="text-text-muted">Hidden</span>;
  }
  if (setting.value === null) {
    return <span className="text-text-muted">Not set</span>;
  }
  return <span className="font-mono-sm break-all">{setting.value}</span>;
}

interface DiffRowProps {
  readonly change: ConfigChangeValidation;
}

/**
 * One row of the server's diff. A refused key is shown with its reason
 * rather than filtered out — an admin needs to know *which* key blocked
 * the set, since the server refuses the whole set rather than part of it.
 *
 * Every element here is a `<span>` carrying a display class, never a
 * `<div>` or `<p>`. This renders inside {@link ConfirmDialog}'s
 * `description`, which Radix emits as a `<p>` — and a `<div>` or a
 * nested `<p>` inside a `<p>` is invalid HTML that the parser silently
 * restructures, so the accessible description the dialog points
 * `aria-describedby` at would no longer contain this diff.
 */
function DiffRow({ change }: DiffRowProps) {
  return (
    <span className="flex flex-col gap-1 border-b border-border-subtle pb-2 last:border-b-0 last:pb-0">
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-mono-sm">{change.key}</span>
        {change.classification === null ? null : (
          <Badge variant="neutral">{CLASSIFICATION_LABELS[change.classification]}</Badge>
        )}
      </span>

      {change.allowed ? (
        <span className="block text-body-sm">
          <span className="text-text-muted">
            {change.currentValue === null ? 'Currently hidden or unset' : change.currentValue}
          </span>{' '}
          <span aria-hidden="true">→</span>{' '}
          <span className="font-mono-sm">{change.proposedValue}</span>
        </span>
      ) : (
        <span className="block text-body-sm text-status-critical-fg">
          {change.reason ?? 'This setting cannot be changed.'}
        </span>
      )}
    </span>
  );
}

export function ConfigPage() {
  const settingsQuery = useConfigSettingsQuery();
  const snapshotsQuery = useConfigSnapshotsQuery();
  const revealMutation = useRevealConfigSettingMutation();
  const validateMutation = useValidateConfigMutation();
  const applyMutation = useApplyConfigMutation();
  const rollbackMutation = useRollbackConfigMutation();

  /** Keys the admin has typed into, mapped to the new value. Never sent until Review. */
  const [edits, setEdits] = useState<Readonly<Record<string, string>>>({});
  /** Secrets revealed this session, key -> unmasked value. Cleared on apply, never cached in react-query. */
  const [revealed, setRevealed] = useState<Readonly<Record<string, string | null>>>({});
  const [validation, setValidation] = useState<ValidateConfigResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<ConfigSnapshotSummary | null>(null);

  const settings = settingsQuery.data ?? [];
  const snapshots = snapshotsQuery.data ?? [];

  const changes: ConfigChangeSet = useMemo(() => {
    const result: Record<string, string> = {};
    for (const setting of settings) {
      const edited = edits[setting.key];
      if (edited === undefined) continue;
      // An edit typed and then reverted to the current value is not a
      // change; sending it would produce a no-op diff row and a
      // misleading audit entry.
      const baseline = revealed[setting.key] ?? setting.value ?? '';
      if (edited === baseline) continue;
      result[setting.key] = edited;
    }
    return result;
  }, [settings, edits, revealed]);

  const changedKeys = Object.keys(changes).sort();

  const reveal = (key: string) => {
    revealMutation.mutate(key, {
      onSuccess: (response) => {
        setRevealed((previous) => ({ ...previous, [key]: response.value }));
      },
      onError: (error) => {
        toast.error(errorMessageOf(error, 'Could not reveal that value.'));
      },
    });
  };

  const review = () => {
    validateMutation.mutate(changes, {
      onSuccess: (response) => {
        setValidation(response);
        setConfirmOpen(true);
      },
      onError: (error) => {
        toast.error(errorMessageOf(error, 'Could not validate these changes.'));
      },
    });
  };

  const confirmApply = () => {
    applyMutation.mutate(changes, {
      onSuccess: (response) => {
        setConfirmOpen(false);
        setValidation(null);
        setEdits({});
        setRevealed({});
        toast.success(
          `Stored ${response.applied.length} setting${response.applied.length === 1 ? '' : 's'}. Restart the panel for them to take effect.`,
        );
      },
      onError: (error) => {
        toast.error(errorMessageOf(error, 'Could not apply these changes.'));
      },
    });
  };

  const confirmRollback = () => {
    const target = rollbackTarget;
    if (target === null) return;
    rollbackMutation.mutate(target.id, {
      onSuccess: (response) => {
        setRollbackTarget(null);
        setEdits({});
        setRevealed({});
        toast.success(
          `Restored ${response.applied.length} setting${response.applied.length === 1 ? '' : 's'} from that snapshot. Restart the panel for them to take effect.`,
        );
      },
      onError: (error) => {
        toast.error(errorMessageOf(error, 'Could not roll back to that snapshot.'));
      },
    });
  };

  const snapshotColumns: readonly DataTableColumn<ConfigSnapshotSummary>[] = [
    {
      id: 'createdAt',
      header: 'Taken',
      cell: (snapshot) => formatDateTime(snapshot.createdAt),
      sortValue: (snapshot) => snapshot.createdAt,
    },
    {
      id: 'createdBy',
      header: 'By',
      cell: (snapshot) => snapshot.createdByLabel,
      sortValue: (snapshot) => snapshot.createdByLabel,
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: (snapshot) => (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setRollbackTarget(snapshot)}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Roll back
        </Button>
      ),
    },
  ];

  if (settingsQuery.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Configuration" description="Allowlisted panel settings." />
        <ErrorState
          message="Could not load configuration settings."
          errorId={errorIdOf(settingsQuery.error)}
          onRetry={() => void settingsQuery.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Configuration"
        description="Allowlisted panel settings. Changes are stored and audited, then take effect on restart."
        action={
          <Button
            type="button"
            onClick={review}
            disabled={changedKeys.length === 0 || validateMutation.isPending}
          >
            Review{' '}
            {changedKeys.length === 0 ? 'changes' : `${changedKeys.length.toString()} changes`}
          </Button>
        }
      />

      <ServerControls />

      {settingsQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="flex flex-col gap-4">
          {settings.map((setting) => {
            const editable = setting.classification !== 'read-only';
            const inputId = `config-${setting.key}`;
            const revealedValue = revealed[setting.key];
            const fieldValue =
              edits[setting.key] ?? revealedValue ?? (setting.masked ? '' : (setting.value ?? ''));

            return (
              <Card key={setting.key}>
                <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <CardTitle className="font-mono-sm">{setting.key}</CardTitle>
                    <p className="text-body-sm text-text-secondary">{setting.description}</p>
                  </div>
                  <Badge variant={editable ? 'neutral' : 'outline'}>
                    {CLASSIFICATION_LABELS[setting.classification]}
                  </Badge>
                </CardHeader>

                <CardContent className="flex flex-col gap-3 text-body-sm">
                  {editable ? (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={inputId}>{setting.label}</Label>
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          id={inputId}
                          className="max-w-md"
                          // A secret's field is a password field until the
                          // admin explicitly reveals it — typing a
                          // replacement never requires exposing the old one.
                          type={setting.secret && revealedValue === undefined ? 'password' : 'text'}
                          placeholder={setting.masked ? 'Hidden — type to replace' : 'Not set'}
                          value={fieldValue}
                          onChange={(event) => {
                            const next = event.target.value;
                            setEdits((previous) => ({ ...previous, [setting.key]: next }));
                          }}
                        />
                        {setting.secret && revealedValue === undefined ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => reveal(setting.key)}
                            disabled={revealMutation.isPending}
                          >
                            <Eye className="size-3.5" aria-hidden="true" />
                            Reveal
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <span className="text-text-muted">{setting.label}</span>
                      <CurrentValue setting={setting} />
                    </div>
                  )}

                  <p className="text-text-secondary">{IMPACT_SENTENCES[setting.classification]}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Snapshots</CardTitle>
        </CardHeader>
        <CardContent className="text-body-sm">
          {snapshotsQuery.isError ? (
            <ErrorState
              message="Could not load snapshots."
              errorId={errorIdOf(snapshotsQuery.error)}
              onRetry={() => void snapshotsQuery.refetch()}
            />
          ) : (
            <>
              <p className="mb-3 text-text-secondary">
                Every apply takes a snapshot of the previous state first. A rollback re-applies one
                of these through the same validate-and-audit path, and takes its own snapshot.
              </p>
              <DataTable
                data={snapshots}
                columns={snapshotColumns}
                getRowId={(snapshot) => snapshot.id}
                caption="Configuration snapshots"
                isLoading={snapshotsQuery.isLoading}
                emptyState={
                  <p className="text-text-secondary">
                    No snapshots yet — the first one is taken when a change is applied.
                  </p>
                }
              />
            </>
          )}
        </CardContent>
      </Card>

      {/*
        Tier 2: reversible (a snapshot is taken first) and it touches no
        mail data, so §8's typed-confirmation tiers do not apply — but it
        does change how the panel will behave after a restart, which is an
        operational consequence and so more than a tier-1 "are you sure".
      */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) setValidation(null);
        }}
        tier={2}
        title="Apply configuration changes"
        confirmLabel="Apply"
        pending={applyMutation.isPending}
        onConfirm={confirmApply}
        description={
          <span className="flex flex-col gap-3">
            <span>
              {validation === null || validation.valid
                ? 'A snapshot of the current values is taken first, so this can be rolled back.'
                : 'One or more of these settings cannot be changed. Nothing will be applied until they are removed from the set.'}
            </span>

            {validation === null ? null : (
              <span className="flex flex-col gap-2">
                {validation.changes.map((change) => (
                  <DiffRow key={change.key} change={change} />
                ))}
              </span>
            )}

            {validation?.highestImpact == null ? null : (
              <span className="text-text-secondary">
                {IMPACT_SENTENCES[validation.highestImpact]}
              </span>
            )}
          </span>
        }
      />

      <ConfirmDialog
        open={rollbackTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRollbackTarget(null);
        }}
        tier={2}
        title="Roll back to this snapshot"
        confirmLabel="Roll back"
        pending={rollbackMutation.isPending}
        onConfirm={confirmRollback}
        description={
          <span>
            Re-applies the editable settings recorded{' '}
            {rollbackTarget === null
              ? 'in this snapshot'
              : formatDateTime(rollbackTarget.createdAt)}
            . Read-only keys in the snapshot are skipped. A new snapshot of the current values is
            taken first, so this is itself reversible, and the panel keeps running with its current
            values until it is restarted.
          </span>
        }
      />
    </div>
  );
}
