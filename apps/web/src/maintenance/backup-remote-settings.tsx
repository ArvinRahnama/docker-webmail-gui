/**
 * The two backup-automation settings surfaces (M13), rendered as cards on the
 * Backups page: the remote destination config and the schedule. Kept out of
 * `backups-page.tsx` so that already-large screen stays focused on the backup
 * list and its per-backup actions.
 *
 * Secrets discipline on the client mirrors the config editor: the S3 secret is
 * never rendered from the fetched status (which only reports whether one is
 * stored), the secret input starts blank and empty means "keep the stored
 * one", and the real value only ever appears through the explicit, audited
 * reveal action.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  BACKUP_FREQUENCIES,
  BACKUP_FREQUENCY_LABELS,
  BACKUP_MODES,
  type BackupDestinationStatus,
  type BackupFrequency,
  type BackupMode,
  type BackupSchedule,
} from '@dwg/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { StatusBadge } from '@/components/status/status-badge';
import { ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import {
  useBackupDestinationQuery,
  useBackupScheduleQuery,
  useRevealBackupDestinationSecretMutation,
  useTestBackupDestinationMutation,
  useUpdateBackupDestinationMutation,
  useUpdateBackupScheduleMutation,
} from './use-maintenance-queries';

const SELECT_CLASS =
  'h-9 w-full rounded-sm border border-border-default bg-bg-surface px-3 text-body-sm text-text-primary';

const BACKUP_MODE_LABELS: Readonly<Record<BackupMode, string>> = {
  warm: 'Warm (container keeps running)',
  cold: 'Cold (container stopped)',
};

function errorMessageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

// ---------------------------------------------------------------------------
// Remote destination
// ---------------------------------------------------------------------------

interface DestinationForm {
  readonly type: 'none' | 's3';
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly accessKeyId: string;
}

function seedForm(status: BackupDestinationStatus): DestinationForm {
  return {
    type: status.type === 's3' ? 's3' : 'none',
    endpoint: status.s3?.endpoint ?? '',
    region: status.s3?.region ?? '',
    bucket: status.s3?.bucket ?? '',
    prefix: status.s3?.prefix ?? '',
    accessKeyId: status.s3?.accessKeyId ?? '',
  };
}

export function RemoteDestinationCard() {
  const destinationQuery = useBackupDestinationQuery();
  const updateMutation = useUpdateBackupDestinationMutation();
  const testMutation = useTestBackupDestinationMutation();
  const revealMutation = useRevealBackupDestinationSecretMutation();

  const [form, setForm] = useState<DestinationForm | null>(null);
  const [secretInput, setSecretInput] = useState('');
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const status = destinationQuery.data;
  // Seed the form when the status first loads. After a save, the mutation's
  // onSuccess re-seeds from the returned status; mid-edit refetches never
  // clobber what the admin is typing.
  useEffect(() => {
    if (status !== undefined && form === null) setForm(seedForm(status));
  }, [status, form]);

  if (form === null || status === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Remote destination</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-body-sm text-text-muted">Loading destination…</p>
        </CardContent>
      </Card>
    );
  }

  const secretStored = status.s3?.secretAccessKeySet ?? false;

  const save = () => {
    if (form.type === 'none') {
      updateMutation.mutate(
        { type: 'none' },
        {
          onSuccess: (next) => {
            setForm(seedForm(next));
            setSecretInput('');
            setRevealedSecret(null);
            toast.success('Remote destination removed');
          },
          onError: (error) =>
            toast.error(errorMessageOf(error, 'Could not update the destination')),
        },
      );
      return;
    }

    if (secretInput.length === 0 && !secretStored) {
      toast.error('Enter the secret access key.');
      return;
    }

    updateMutation.mutate(
      {
        type: 's3',
        endpoint: form.endpoint,
        region: form.region,
        bucket: form.bucket,
        prefix: form.prefix,
        accessKeyId: form.accessKeyId,
        // Empty means "keep the stored secret"; the server treats an omitted
        // secret that way, so it is left off rather than sent blank.
        ...(secretInput.length > 0 ? { secretAccessKey: secretInput } : {}),
      },
      {
        onSuccess: (next) => {
          setForm(seedForm(next));
          setSecretInput('');
          setRevealedSecret(null);
          toast.success('Remote destination saved');
        },
        onError: (error) => toast.error(errorMessageOf(error, 'Could not save the destination')),
      },
    );
  };

  const test = () => {
    testMutation.mutate(undefined, {
      onSuccess: () => toast.success('Connected to the remote successfully'),
      onError: (error) => toast.error(errorMessageOf(error, 'Could not reach the remote')),
    });
  };

  const reveal = () => {
    revealMutation.mutate(undefined, {
      onSuccess: (result) => setRevealedSecret(result.value ?? ''),
      onError: (error) => toast.error(errorMessageOf(error, 'Could not reveal the secret')),
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>Remote destination</CardTitle>
        {status.configured ? (
          <StatusBadge status="healthy" label="Configured" />
        ) : (
          <StatusBadge status="unknown" label="Not configured" />
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-body-sm text-text-secondary">
          Where verified backups are uploaded. The VPS is only staging — once a backup is uploaded
          and verified on the remote, its local copy is reclaimed.
        </p>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="destination-type">Destination</Label>
          <select
            id="destination-type"
            className={SELECT_CLASS}
            value={form.type}
            onChange={(event) =>
              setForm({ ...form, type: event.target.value === 's3' ? 's3' : 'none' })
            }
          >
            <option value="none">None — keep backups on the VPS only</option>
            <option value="s3">Amazon S3 (or S3-compatible)</option>
          </select>
        </div>

        {form.type === 's3' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="s3-endpoint">Endpoint</Label>
              <Input
                id="s3-endpoint"
                value={form.endpoint}
                onChange={(event) => setForm({ ...form, endpoint: event.target.value })}
                placeholder="https://s3.us-east-1.amazonaws.com"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="s3-region">Region</Label>
              <Input
                id="s3-region"
                value={form.region}
                onChange={(event) => setForm({ ...form, region: event.target.value })}
                placeholder="us-east-1"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="s3-bucket">Bucket</Label>
              <Input
                id="s3-bucket"
                value={form.bucket}
                onChange={(event) => setForm({ ...form, bucket: event.target.value })}
                placeholder="my-mail-backups"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="s3-prefix">Prefix (optional)</Label>
              <Input
                id="s3-prefix"
                value={form.prefix}
                onChange={(event) => setForm({ ...form, prefix: event.target.value })}
                placeholder="backups"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="s3-access-key-id">Access key ID</Label>
              <Input
                id="s3-access-key-id"
                value={form.accessKeyId}
                onChange={(event) => setForm({ ...form, accessKeyId: event.target.value })}
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="s3-secret">Secret access key</Label>
              <Input
                id="s3-secret"
                type="password"
                value={secretInput}
                onChange={(event) => setSecretInput(event.target.value)}
                autoComplete="off"
                placeholder={secretStored ? 'Stored — leave blank to keep' : 'Secret access key'}
              />
              {secretStored ? (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    pending={revealMutation.isPending}
                    onClick={reveal}
                  >
                    Reveal stored secret
                  </Button>
                  {revealedSecret !== null ? (
                    <code className="font-mono-sm break-all text-text-secondary">
                      {revealedSecret === '' ? '(none)' : revealedSecret}
                    </code>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" pending={updateMutation.isPending} onClick={save}>
            Save destination
          </Button>
          {form.type === 's3' ? (
            <Button
              type="button"
              variant="secondary"
              pending={testMutation.isPending}
              disabled={!status.configured}
              onClick={test}
            >
              Test connection
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

interface ScheduleForm {
  readonly frequency: BackupFrequency;
  readonly mode: BackupMode;
  readonly retentionKeep: number;
  readonly retentionMaxAgeDays: number | null;
  readonly uploadToRemote: boolean;
}

function seedSchedule(schedule: BackupSchedule): ScheduleForm {
  return {
    frequency: schedule.frequency,
    mode: schedule.mode,
    retentionKeep: schedule.retentionKeep,
    retentionMaxAgeDays: schedule.retentionMaxAgeDays,
    uploadToRemote: schedule.uploadToRemote,
  };
}

export function BackupScheduleCard() {
  const scheduleQuery = useBackupScheduleQuery();
  const updateMutation = useUpdateBackupScheduleMutation();
  const [form, setForm] = useState<ScheduleForm | null>(null);

  const schedule = scheduleQuery.data;
  useEffect(() => {
    if (schedule !== undefined && form === null) setForm(seedSchedule(schedule));
  }, [schedule, form]);

  if (form === null || schedule === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Schedule</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-body-sm text-text-muted">Loading schedule…</p>
        </CardContent>
      </Card>
    );
  }

  const save = () => {
    updateMutation.mutate(
      {
        frequency: form.frequency,
        mode: form.mode,
        retentionKeep: form.retentionKeep,
        retentionMaxAgeDays: form.retentionMaxAgeDays,
        uploadToRemote: form.uploadToRemote,
      },
      {
        onSuccess: (next) => {
          setForm(seedSchedule(next));
          toast.success('Schedule saved');
        },
        onError: (error) => toast.error(errorMessageOf(error, 'Could not save the schedule')),
      },
    );
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>Schedule</CardTitle>
        {schedule.enabled ? (
          <StatusBadge
            status="healthy"
            label={
              schedule.nextRunAt === null
                ? 'Enabled'
                : `Next run ${formatDateTime(schedule.nextRunAt)}`
            }
          />
        ) : (
          <StatusBadge status="unknown" label="Off" />
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-body-sm text-text-secondary">
          Automatic backups run in the background on the interval you choose, and survive a restart.
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-frequency">Frequency</Label>
            <select
              id="schedule-frequency"
              className={SELECT_CLASS}
              value={form.frequency}
              onChange={(event) =>
                setForm({ ...form, frequency: event.target.value as BackupFrequency })
              }
            >
              {BACKUP_FREQUENCIES.map((frequency) => (
                <option key={frequency} value={frequency}>
                  {BACKUP_FREQUENCY_LABELS[frequency]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-mode">Mode</Label>
            <select
              id="schedule-mode"
              className={SELECT_CLASS}
              value={form.mode}
              onChange={(event) => setForm({ ...form, mode: event.target.value as BackupMode })}
            >
              {BACKUP_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {BACKUP_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="retention-keep">Keep the newest</Label>
            <div className="flex items-center gap-2">
              <Input
                id="retention-keep"
                type="number"
                min={1}
                className="max-w-24"
                value={form.retentionKeep}
                onChange={(event) =>
                  setForm({ ...form, retentionKeep: Math.max(1, Number(event.target.value) || 1) })
                }
              />
              <span className="text-body-sm text-text-secondary">backups</span>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="retention-age-toggle">Also delete older than</Label>
            <div className="flex items-center gap-2">
              <Switch
                id="retention-age-toggle"
                checked={form.retentionMaxAgeDays !== null}
                onCheckedChange={(checked) =>
                  setForm({ ...form, retentionMaxAgeDays: checked ? 30 : null })
                }
              />
              <Input
                type="number"
                min={1}
                aria-label="Maximum age in days"
                className="max-w-24"
                disabled={form.retentionMaxAgeDays === null}
                value={form.retentionMaxAgeDays ?? ''}
                onChange={(event) =>
                  setForm({
                    ...form,
                    retentionMaxAgeDays: Math.max(1, Number(event.target.value) || 1),
                  })
                }
              />
              <span className="text-body-sm text-text-secondary">days</span>
            </div>
          </div>
        </div>

        <label className="flex items-center gap-2 text-body-sm text-text-primary">
          <Switch
            checked={form.uploadToRemote}
            onCheckedChange={(checked) => setForm({ ...form, uploadToRemote: checked })}
          />
          Upload backups to the remote destination automatically
        </label>

        <div>
          <Button type="button" pending={updateMutation.isPending} onClick={save}>
            Save schedule
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
