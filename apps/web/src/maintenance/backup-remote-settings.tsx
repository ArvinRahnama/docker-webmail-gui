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
 *
 * Validation is never swallowed: the destination form checks the update
 * against the shared schema before sending it, and both those issues and the
 * server's `VALIDATION_FAILED` details land inline under the offending input,
 * with a toast that names the field.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ZodError } from 'zod';
import {
  BACKUP_FREQUENCIES,
  BACKUP_FREQUENCY_LABELS,
  BACKUP_MODES,
  BackupDestinationUpdateSchema,
  type BackupDestinationStatus,
  type BackupDestinationUpdateInput,
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
import { ApiClientError, ApiError } from '@/lib/api-client';
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

/**
 * Two field columns only where the card itself is wide enough for them
 * (`@lg`: a 32rem content box, set by `@container` on the CardContent). The
 * card's width depends on the sidebar and on whether the cards sit two-up,
 * so the viewport is the wrong thing to ask: at 1440px a two-up card has room
 * for two columns, at 1280px two columns would truncate the Mode select.
 */
const FIELD_GRID_CLASS = 'grid grid-cols-1 gap-4 @lg:grid-cols-2';

const BACKUP_MODE_LABELS: Readonly<Record<BackupMode, string>> = {
  warm: 'Warm (container keeps running)',
  cold: 'Cold (container stopped)',
};

function errorMessageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof ApiClientError ? error.message : fallback;
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

/** Field name (as the schema and the server's `details[].path` spell it) -> its label, for toasts. */
const DESTINATION_FIELD_LABELS: Readonly<Record<string, string>> = {
  endpoint: 'Endpoint',
  region: 'Region',
  bucket: 'Bucket',
  prefix: 'Prefix',
  accessKeyId: 'Access key ID',
  secretAccessKey: 'Secret access key',
  host: 'Host',
  port: 'Port',
  path: 'Path',
  user: 'Username',
  password: 'Password',
};

interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

type FieldErrors = Readonly<Record<string, string>>;

/** The server's per-field `VALIDATION_FAILED` details (`[{ path, message }]`, see `parseBody`), or `null` for any other error. */
function serverFieldIssuesOf(error: unknown): readonly FieldIssue[] | null {
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_FAILED') return null;
  if (!Array.isArray(error.details)) return null;
  const issues = error.details.flatMap((detail) =>
    typeof detail === 'object' &&
    detail !== null &&
    !Array.isArray(detail) &&
    typeof detail['path'] === 'string' &&
    typeof detail['message'] === 'string'
      ? [{ path: detail['path'], message: detail['message'] }]
      : [],
  );
  return issues.length > 0 ? issues : null;
}

/** The shared schema's own issues, in the same `{ path, message }` shape as the server's details. */
function schemaFieldIssuesOf(error: ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** First message per field, keyed by field name. */
function fieldErrorsOf(issues: readonly FieldIssue[]): FieldErrors {
  const errors: Record<string, string> = {};
  for (const issue of issues) errors[issue.path] ??= issue.message;
  return errors;
}

/** "Region: Use the provider's region code…" — the toast names the field, since it may be scrolled out of view on a phone. */
function issuesToastMessage(issues: readonly FieldIssue[]): string {
  const [first] = issues;
  if (first === undefined) return 'Could not save the destination';
  const label = DESTINATION_FIELD_LABELS[first.path] ?? 'Destination';
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : '';
  return `${label}: ${first.message}${more}`;
}

/** Wires an input to its hint and error text; `aria-invalid` only while an error shows. */
function fieldA11y(
  id: string,
  error: string | undefined,
  hasHint = false,
): { 'aria-invalid'?: true; 'aria-describedby'?: string } {
  const describedBy = [hasHint ? `${id}-hint` : null, error !== undefined ? `${id}-error` : null]
    .filter((part) => part !== null)
    .join(' ');
  return {
    ...(error !== undefined ? { 'aria-invalid': true } : {}),
    ...(describedBy !== '' ? { 'aria-describedby': describedBy } : {}),
  };
}

function FieldHint({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <p id={`${id}-hint`} className="text-caption text-text-muted">
      {children}
    </p>
  );
}

function FieldError({ id, error }: { readonly id: string; readonly error: string | undefined }) {
  if (error === undefined) return null;
  return (
    <p id={`${id}-error`} role="alert" className="text-caption text-status-critical-fg">
      {error}
    </p>
  );
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
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

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

  const clearFieldError = (key: string) => {
    if (fieldErrors[key] === undefined) return;
    const { [key]: _cleared, ...rest } = fieldErrors;
    setFieldErrors(rest);
  };
  /** Edits one field and drops its error — the admin is fixing it. */
  const setField = <K extends keyof DestinationForm>(key: K, value: DestinationForm[K]) => {
    setForm({ ...form, [key]: value });
    clearFieldError(key);
  };
  const showIssues = (issues: readonly FieldIssue[]) => {
    setFieldErrors(fieldErrorsOf(issues));
    toast.error(issuesToastMessage(issues));
  };

  const onSaved = (next: BackupDestinationStatus, message: string) => {
    setForm(seedForm(next));
    setSecretInput('');
    setRevealedSecret(null);
    setFieldErrors({});
    toast.success(message);
  };
  const onSaveError = (error: unknown) => {
    // A `ZodError` is the API wrapper's own parse of the update (see
    // `updateBackupDestination`); it gets the same inline treatment as the
    // server's VALIDATION_FAILED details.
    const issues =
      error instanceof ZodError ? schemaFieldIssuesOf(error) : serverFieldIssuesOf(error);
    if (issues !== null) showIssues(issues);
    else toast.error(errorMessageOf(error, 'Could not save the destination'));
  };

  const save = () => {
    if (form.type === 'none') {
      updateMutation.mutate(
        { type: 'none' },
        { onSuccess: (next) => onSaved(next, 'Remote destination removed'), onError: onSaveError },
      );
      return;
    }

    // Empty means "keep the stored secret" — omitted rather than sent blank, so
    // the server keeps what it has.
    const secretField = secretInput.length > 0 ? secretInput : undefined;
    const update: BackupDestinationUpdateInput =
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

    // Checked here rather than left to the API wrapper's own parse, so the
    // schema's per-field issues reach the form instead of a generic toast. The
    // secret is optional to the schema (omitted = keep), so a missing one for
    // a type with nothing stored is added here, all shown at once.
    const checked = BackupDestinationUpdateSchema.safeParse(update);
    const issues: FieldIssue[] = checked.success ? [] : schemaFieldIssuesOf(checked.error);
    if (secretField === undefined && !storedForCurrentType) {
      issues.push(
        form.type === 's3'
          ? { path: 'secretAccessKey', message: 'Enter the secret access key.' }
          : { path: 'password', message: 'Enter the password.' },
      );
    }
    if (issues.length > 0) {
      showIssues(issues);
      return;
    }

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
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <CardTitle>Remote destination</CardTitle>
        {status.configured ? (
          <StatusBadge status="healthy" label="Configured" className="whitespace-nowrap" />
        ) : (
          <StatusBadge status="unknown" label="Not configured" className="whitespace-nowrap" />
        )}
      </CardHeader>
      <CardContent className="@container flex flex-col gap-4">
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
              // The S3 secret and the FTP password share one input state: a
              // value typed for the old type must never be saved as the new
              // type's credential.
              setSecretInput('');
              setRevealedSecret(null);
              setFieldErrors({});
            }}
          >
            <option value="none">None — keep backups on the VPS only</option>
            <option value="s3">Amazon S3 (or S3-compatible)</option>
            <option value="ftp">FTP / FTPS</option>
          </select>
        </div>

        {form.type === 's3' ? (
          <div className={FIELD_GRID_CLASS}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="s3-endpoint">Endpoint</Label>
              <Input
                id="s3-endpoint"
                value={form.endpoint}
                onChange={(event) => setField('endpoint', event.target.value)}
                placeholder="s3.us-east-1.amazonaws.com"
                autoCapitalize="off"
                spellCheck={false}
                {...fieldA11y('s3-endpoint', fieldErrors['endpoint'], true)}
              />
              <FieldHint id="s3-endpoint">
                The provider&apos;s S3 host. https:// is added if you leave it out.
              </FieldHint>
              <FieldError id="s3-endpoint" error={fieldErrors['endpoint']} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="s3-region">Region (optional)</Label>
              <Input
                id="s3-region"
                value={form.region}
                onChange={(event) => setField('region', event.target.value)}
                placeholder="us-east-1"
                autoCapitalize="off"
                spellCheck={false}
                {...fieldA11y('s3-region', fieldErrors['region'], true)}
              />
              <FieldHint id="s3-region">
                A region code like us-east-1, not a display name. Leave blank if the provider has
                none.
              </FieldHint>
              <FieldError id="s3-region" error={fieldErrors['region']} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="s3-bucket">Bucket</Label>
              <Input
                id="s3-bucket"
                value={form.bucket}
                onChange={(event) => setField('bucket', event.target.value)}
                placeholder="my-mail-backups"
                autoCapitalize="off"
                spellCheck={false}
                {...fieldA11y('s3-bucket', fieldErrors['bucket'], true)}
              />
              <FieldHint id="s3-bucket">
                If the endpoint host starts with a bucket name (bucket.provider.net), that first
                part is the bucket.
              </FieldHint>
              <FieldError id="s3-bucket" error={fieldErrors['bucket']} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="s3-prefix">Prefix (optional)</Label>
              <Input
                id="s3-prefix"
                value={form.prefix}
                onChange={(event) => setField('prefix', event.target.value)}
                placeholder="backups"
                autoCapitalize="off"
                spellCheck={false}
                {...fieldA11y('s3-prefix', fieldErrors['prefix'])}
              />
              <FieldError id="s3-prefix" error={fieldErrors['prefix']} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="s3-access-key-id">Access key ID</Label>
              <Input
                id="s3-access-key-id"
                value={form.accessKeyId}
                onChange={(event) => setField('accessKeyId', event.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                {...fieldA11y('s3-access-key-id', fieldErrors['accessKeyId'])}
              />
              <FieldError id="s3-access-key-id" error={fieldErrors['accessKeyId']} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="s3-secret">Secret access key</Label>
              <Input
                id="s3-secret"
                type="password"
                value={secretInput}
                onChange={(event) => {
                  setSecretInput(event.target.value);
                  clearFieldError('secretAccessKey');
                }}
                autoComplete="off"
                placeholder={
                  storedForCurrentType ? 'Stored — leave blank to keep' : 'Secret access key'
                }
                {...fieldA11y('s3-secret', fieldErrors['secretAccessKey'])}
              />
              <FieldError id="s3-secret" error={fieldErrors['secretAccessKey']} />
              {storedForCurrentType ? (
                // Wraps so a long revealed value drops under the button instead
                // of being squeezed into a one-character column beside it.
                <div className="flex flex-wrap items-center gap-2">
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
                    <code className="min-w-0 font-mono-sm break-all text-text-secondary">
                      {revealedSecret === '' ? '(none)' : revealedSecret}
                    </code>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {form.type === 'ftp' ? (
          <div className={FIELD_GRID_CLASS}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ftp-host">Host</Label>
              <Input
                id="ftp-host"
                value={form.host}
                onChange={(event) => setField('host', event.target.value)}
                placeholder="ftp.example.com"
                autoCapitalize="off"
                spellCheck={false}
                {...fieldA11y('ftp-host', fieldErrors['host'])}
              />
              <FieldError id="ftp-host" error={fieldErrors['host']} />
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
                  setField('port', Math.max(1, Number(event.target.value) || 21))
                }
                {...fieldA11y('ftp-port', fieldErrors['port'])}
              />
              <FieldError id="ftp-port" error={fieldErrors['port']} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ftp-user">Username</Label>
              <Input
                id="ftp-user"
                value={form.user}
                onChange={(event) => setField('user', event.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                {...fieldA11y('ftp-user', fieldErrors['user'])}
              />
              <FieldError id="ftp-user" error={fieldErrors['user']} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ftp-path">Path (optional)</Label>
              <Input
                id="ftp-path"
                value={form.path}
                onChange={(event) => setField('path', event.target.value)}
                placeholder="backups"
                autoCapitalize="off"
                spellCheck={false}
                {...fieldA11y('ftp-path', fieldErrors['path'])}
              />
              <FieldError id="ftp-path" error={fieldErrors['path']} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ftp-password">Password</Label>
              <Input
                id="ftp-password"
                type="password"
                value={secretInput}
                onChange={(event) => {
                  setSecretInput(event.target.value);
                  clearFieldError('password');
                }}
                autoComplete="off"
                placeholder={storedForCurrentType ? 'Stored — leave blank to keep' : 'Password'}
                {...fieldA11y('ftp-password', fieldErrors['password'])}
              />
              <FieldError id="ftp-password" error={fieldErrors['password']} />
              {storedForCurrentType ? (
                <div className="flex flex-wrap items-center gap-2">
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
                    <code className="min-w-0 font-mono-sm break-all text-text-secondary">
                      {revealedSecret === '' ? '(none)' : revealedSecret}
                    </code>
                  ) : null}
                </div>
              ) : null}
            </div>
            <label className="flex items-center gap-2 text-body-sm text-text-primary col-span-full">
              <Switch
                checked={form.secure}
                onCheckedChange={(checked) => setForm({ ...form, secure: checked })}
              />
              Use FTPS (explicit TLS)
            </label>
            {!form.secure ? (
              <p className="text-body-sm text-status-warning-fg col-span-full">
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
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <CardTitle>Schedule</CardTitle>
        {schedule.enabled ? (
          <StatusBadge
            status="healthy"
            className="whitespace-nowrap"
            label={
              schedule.nextRunAt === null
                ? 'Enabled'
                : `Next run ${formatDateTime(schedule.nextRunAt)}`
            }
          />
        ) : (
          <StatusBadge status="unknown" label="Off" className="whitespace-nowrap" />
        )}
      </CardHeader>
      <CardContent className="@container flex flex-col gap-4">
        <p className="text-body-sm text-text-secondary">
          Automatic backups run in the background on the interval you choose, and survive a restart.
        </p>

        <div className={FIELD_GRID_CLASS}>
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
          // `min-w-0` stops the list's min-content (the id) from widening the
          // dialog's grid track; the id wraps rather than truncates because it
          // is what the admin is choosing by.
          <ul className="flex min-w-0 flex-col divide-y divide-border-subtle">
            {backups.map((backup) => (
              <li key={backup.key} className="flex items-center justify-between gap-3 py-2">
                <div className="flex min-w-0 flex-col">
                  <span className="font-mono-sm break-all text-text-primary">
                    {backup.backupId}
                  </span>
                  <span className="text-caption text-text-muted">
                    {formatBytes(backup.sizeBytes)} · {formatDateTime(backup.lastModified)}
                  </span>
                </div>
                {backup.alreadyLocal ? (
                  <Badge variant="neutral" className="shrink-0">
                    Already local
                  </Badge>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
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
