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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { StatusBadge } from '@/components/status/status-badge';
import { ApiError } from '@/lib/api-client';
import { formatBytes, formatDateTime } from '@/lib/format';
import {
  useBackupDestinationQuery,
  useBackupScheduleQuery,
  useImportRemoteBackupMutation,
  useRemoteBackupsQuery,
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
  readonly type: 'none' | 's3' | 'ftp';
  // S3
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly accessKeyId: string;
  // FTP
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly user: string;
  readonly secure: boolean;
}

function seedForm(status: BackupDestinationStatus): DestinationForm {
  return {
    type: status.type === 's3' ? 's3' : status.type === 'ftp' ? 'ftp' : 'none',
    endpoint: status.s3?.endpoint ?? '',
    region: status.s3?.region ?? '',
    bucket: status.s3?.bucket ?? '',
    prefix: status.s3?.prefix ?? '',
    accessKeyId: status.s3?.accessKeyId ?? '',
    host: status.ftp?.host ?? '',
    port: status.ftp?.port ?? 21,
    path: status.ftp?.path ?? '',
    user: status.ftp?.user ?? '',
    secure: status.ftp?.secure ?? true,
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

  // Whether a secret/password is already stored FOR THE CURRENTLY SELECTED
  // type. Switching type (e.g. S3 -> FTP) means nothing is stored for the new
  // type yet, so the secret must be entered.
  const storedForCurrentType =
    form.type === 's3' && status.type === 's3'
      ? (status.s3?.secretAccessKeySet ?? false)
      : form.type === 'ftp' && status.type === 'ftp'
        ? (status.ftp?.passwordSet ?? false)
        : false;

  const onSaved = (next: BackupDestinationStatus, message: string) => {
    setForm(seedForm(next));
    setSecretInput('');
    setRevealedSecret(null);
    toast.success(message);
  };
  const onSaveError = (error: unknown) =>
    toast.error(errorMessageOf(error, 'Could not save the destination'));

  const save = () => {
    if (form.type === 'none') {
      updateMutation.mutate(
        { type: 'none' },
        { onSuccess: (next) => onSaved(next, 'Remote destination removed'), onError: onSaveError },
      );
      return;
    }

    if (secretInput.length === 0 && !storedForCurrentType) {
      toast.error(form.type === 's3' ? 'Enter the secret access key.' : 'Enter the password.');
      return;
    }

    // Empty means "keep the stored secret" — omitted rather than sent blank, so
    // the server keeps what it has.
    const secretField = secretInput.length > 0 ? secretInput : undefined;
    const update =
      form.type === 's3'
        ? {
            type: 's3' as const,
            endpoint: form.endpoint,
            region: form.region,
            bucket: form.bucket,
            prefix: form.prefix,
            accessKeyId: form.accessKeyId,
            ...(secretField !== undefined ? { secretAccessKey: secretField } : {}),
          }
        : {
            type: 'ftp' as const,
            host: form.host,
            port: form.port,
            path: form.path,
            user: form.user,
            secure: form.secure,
            ...(secretField !== undefined ? { password: secretField } : {}),
          };

    updateMutation.mutate(update, {
      onSuccess: (next) => onSaved(next, 'Remote destination saved'),
      onError: onSaveError,
    });
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
            onChange={(event) => {
              const value = event.target.value;
              setForm({
                ...form,
                type: value === 's3' ? 's3' : value === 'ftp' ? 'ftp' : 'none',
              });
              setRevealedSecret(null);
            }}
          >
            <option value="none">None — keep backups on the VPS only</option>
            <option value="s3">Amazon S3 (or S3-compatible)</option>
            <option value="ftp">FTP / FTPS</option>
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
                placeholder={
                  storedForCurrentType ? 'Stored — leave blank to keep' : 'Secret access key'
                }
              />
              {storedForCurrentType ? (
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

        {form.type === 'ftp' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ftp-host">Host</Label>
              <Input
                id="ftp-host"
                value={form.host}
                onChange={(event) => setForm({ ...form, host: event.target.value })}
                placeholder="ftp.example.com"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ftp-port">Port</Label>
              <Input
                id="ftp-port"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(event) =>
                  setForm({ ...form, port: Math.max(1, Number(event.target.value) || 21) })
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ftp-user">Username</Label>
              <Input
                id="ftp-user"
                value={form.user}
                onChange={(event) => setForm({ ...form, user: event.target.value })}
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ftp-path">Path (optional)</Label>
              <Input
                id="ftp-path"
                value={form.path}
                onChange={(event) => setForm({ ...form, path: event.target.value })}
                placeholder="backups"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ftp-password">Password</Label>
              <Input
                id="ftp-password"
                type="password"
                value={secretInput}
                onChange={(event) => setSecretInput(event.target.value)}
                autoComplete="off"
                placeholder={storedForCurrentType ? 'Stored — leave blank to keep' : 'Password'}
              />
              {storedForCurrentType ? (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    pending={revealMutation.isPending}
                    onClick={reveal}
                  >
                    Reveal stored password
                  </Button>
                  {revealedSecret !== null ? (
                    <code className="font-mono-sm break-all text-text-secondary">
                      {revealedSecret === '' ? '(none)' : revealedSecret}
                    </code>
                  ) : null}
                </div>
              ) : null}
            </div>
            <label className="flex items-center gap-2 text-body-sm text-text-primary sm:col-span-2">
              <Switch
                checked={form.secure}
                onCheckedChange={(checked) => setForm({ ...form, secure: checked })}
              />
              Use FTPS (explicit TLS)
            </label>
            {!form.secure ? (
              <p className="text-body-sm text-status-warning-fg sm:col-span-2">
                Plaintext FTP sends the password and backup data unencrypted. Enable FTPS unless the
                server genuinely does not support it.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" pending={updateMutation.isPending} onClick={save}>
            Save destination
          </Button>
          {form.type !== 'none' ? (
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

// ---------------------------------------------------------------------------
// Browse remote + import (restore-from-remote, step one). Importing pulls the
// archive down and verifies it server-side; the backup then appears in the
// local list, where the normal four-tier Restore takes over. The two steps are
// deliberately separate so restore keeps every one of its confirmation gates.
// ---------------------------------------------------------------------------

export interface RemoteBrowseDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Called with the import job id when an import starts, so the page can show its progress. */
  readonly onImportStarted: (jobId: string) => void;
}

export function RemoteBrowseDialog({
  open,
  onOpenChange,
  onImportStarted,
}: RemoteBrowseDialogProps) {
  const remoteQuery = useRemoteBackupsQuery(open);
  const importMutation = useImportRemoteBackupMutation();
  const backups = remoteQuery.data ?? [];

  const startImport = (backupId: string) => {
    importMutation.mutate(backupId, {
      onSuccess: (jobId) => {
        onOpenChange(false);
        onImportStarted(jobId);
        toast.success('Import started — the backup will appear in the list once verified');
      },
      onError: (error) => toast.error(errorMessageOf(error, 'Could not import this backup')),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Backups on the remote</DialogTitle>
          <DialogDescription>
            Import a backup to pull it down and verify it. It then joins the list below, where you
            can restore it through the usual confirmation.
          </DialogDescription>
        </DialogHeader>

        {remoteQuery.isError ? (
          <p className="text-body-sm text-status-critical-fg">Could not list the remote backups.</p>
        ) : remoteQuery.isLoading ? (
          <p className="text-body-sm text-text-muted">Loading…</p>
        ) : backups.length === 0 ? (
          <p className="text-body-sm text-text-muted">
            No backups on the remote yet — nothing has been uploaded.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle">
            {backups.map((backup) => (
              <li key={backup.key} className="flex items-center justify-between gap-3 py-2">
                <div className="flex min-w-0 flex-col">
                  <span className="font-mono-sm truncate text-text-primary">{backup.backupId}</span>
                  <span className="text-caption text-text-muted">
                    {formatBytes(backup.sizeBytes)} · {formatDateTime(backup.lastModified)}
                  </span>
                </div>
                {backup.alreadyLocal ? (
                  <Badge variant="neutral">Already local</Badge>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    pending={importMutation.isPending}
                    onClick={() => startImport(backup.backupId)}
                  >
                    Import
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
