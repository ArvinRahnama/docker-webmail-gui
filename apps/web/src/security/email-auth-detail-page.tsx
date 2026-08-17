import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Copy, KeyRound, RefreshCw } from 'lucide-react';
import type { DkimKeysize, PropagationRecordType } from '@dwg/shared';
import { DKIM_KEYSIZES, PROPAGATION_RECORD_TYPES } from '@dwg/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DnsRecordCard } from '@/components/dns-record-card';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/status/status-badge';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import {
  useDkimStatusQuery,
  useDnsPropagationQuery,
  useEmailAuthReportQuery,
  useGenerateDkimMutation,
} from './use-security-queries';

const DEFAULT_SELECTOR = 'mail';

const RECORD_TYPE_LABEL: Readonly<Record<PropagationRecordType, string>> = {
  MX: 'MX',
  TXT_SPF: 'SPF (TXT)',
  TXT_DKIM: 'DKIM (TXT)',
  TXT_DMARC: 'DMARC (TXT)',
  A: 'A',
  AAAA: 'AAAA',
};

/**
 * `/security/email-auth/:domain` (FEATURE_MATRIX.md §10;
 * UX_ARCHITECTURE.md §6.2). Every record's state comes from its own
 * independent check — one resolver failure never blanks the rest of the
 * page (UX_ARCHITECTURE.md §9's "partial/degraded" rule).
 */
export function EmailAuthDetailPage() {
  const { domain = '' } = useParams<{ domain: string }>();
  const navigate = useNavigate();
  const [selectorInput, setSelectorInput] = useState(DEFAULT_SELECTOR);
  const [selector, setSelector] = useState(DEFAULT_SELECTOR);
  const [propagationType, setPropagationType] = useState<PropagationRecordType>('TXT_SPF');
  const [propagationRequested, setPropagationRequested] = useState(false);
  const [dkimKeysize, setDkimKeysize] = useState<DkimKeysize>(2048);
  const [confirmGenerateOpen, setConfirmGenerateOpen] = useState(false);

  const report = useEmailAuthReportQuery(domain, selector);
  const propagation = useDnsPropagationQuery(
    domain,
    propagationType,
    selector,
    propagationRequested,
  );
  const dkimStatus = useDkimStatusQuery(domain, selector);
  const generateDkimMutation = useGenerateDkimMutation(domain);

  async function copyDkimRecord(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copied to clipboard.');
    } catch {
      toast.error('Could not copy — your browser blocked clipboard access.');
    }
  }

  function handleGenerateConfirm() {
    generateDkimMutation.mutate(
      { selector, keysize: dkimKeysize },
      {
        onSuccess: () => {
          toast.success(
            'DKIM key generated. Publish the new record, then verify once DNS updates.',
          );
          setConfirmGenerateOpen(false);
        },
        onError: (err) => {
          toast.error(err instanceof ApiError ? err.message : 'Could not generate a DKIM key.');
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate('/security/email-auth')}
        className="w-fit"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Back to Email Authentication
      </Button>

      <PageHeader
        title={domain}
        description="Live DNS checks against public resolvers. A resolver failure is shown as Unknown, never as a false Invalid."
        action={
          <Button
            type="button"
            variant="secondary"
            pending={report.isFetching}
            onClick={() => void report.refetch()}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Re-check
          </Button>
        }
      />

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dkim-selector">DKIM selector</Label>
            <Input
              id="dkim-selector"
              value={selectorInput}
              onChange={(event) => setSelectorInput(event.target.value)}
              className="w-40"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setSelector(selectorInput.trim() || DEFAULT_SELECTOR)}
          >
            Apply
          </Button>
          {report.data ? (
            <span className="ml-auto text-caption text-text-muted">
              Last checked {formatDateTime(report.data.checkedAt)}
            </span>
          ) : null}
        </CardContent>
      </Card>

      {report.isError ? (
        <ErrorState
          message="Could not run the DNS check."
          errorId={
            report.error instanceof ApiError || report.error instanceof ApiClientError
              ? report.error.errorId
              : 'unknown'
          }
          onRetry={() => void report.refetch()}
        />
      ) : report.isLoading || !report.data ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <DnsRecordCard
            title="MX"
            state={report.data.mx.state}
            values={report.data.mx.records.map((r) => `${r.priority} ${r.exchange}`)}
            description="Mail exchangers — where mail addressed to this domain is delivered."
            issues={report.data.mx.issues}
          />
          <DnsRecordCard
            title="SPF"
            state={report.data.spf.state}
            values={report.data.spf.record ? [report.data.spf.record] : report.data.spf.allRecords}
            description="Sender Policy Framework — which hosts are authorised to send mail as this domain."
            issues={report.data.spf.issues}
          />
          <DnsRecordCard
            title={`DKIM (${report.data.dkim.selector})`}
            state={report.data.dkim.state}
            values={report.data.dkim.record ? [report.data.dkim.record] : []}
            description="DomainKeys Identified Mail — the public key published for this selector."
            issues={report.data.dkim.issues}
          />
          <DnsRecordCard
            title="DMARC"
            state={report.data.dmarc.state}
            values={report.data.dmarc.record ? [report.data.dmarc.record] : []}
            description="Domain-based Message Authentication — the policy for mail that fails SPF/DKIM."
            issues={report.data.dmarc.issues}
          />
          <DnsRecordCard
            title="Reverse DNS (PTR)"
            state={report.data.ptr.state}
            values={Object.entries(report.data.ptr.ptrByAddress).map(
              ([address, hostnames]) =>
                `${address} → ${hostnames.length > 0 ? hostnames.join(', ') : '(no PTR record)'}`,
            )}
            description="Whether the domain's mail-sending addresses resolve back to a hostname."
            issues={report.data.ptr.issues}
          />
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-body font-semibold">DKIM key management</CardTitle>
          {dkimStatus.data ? (
            <StatusBadge
              status={
                dkimStatus.data.publicRecord === null
                  ? 'unknown'
                  : dkimStatus.data.matchesDns === true
                    ? 'healthy'
                    : dkimStatus.data.matchesDns === false
                      ? 'warning'
                      : 'info'
              }
              label={
                dkimStatus.data.publicRecord === null
                  ? 'No key generated'
                  : dkimStatus.data.matchesDns === true
                    ? 'DNS matches'
                    : dkimStatus.data.matchesDns === false
                      ? 'DNS does not match yet'
                      : 'DNS not checked'
              }
            />
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-body-sm text-text-secondary">
            Generates a key pair via <code className="font-mono-sm">setup config dkim</code> for
            this domain and selector. Only the public DNS record is ever shown here — the private
            key never leaves the mail server. After generating, copy the record below into your DNS
            provider (publish), then re-check to confirm DNS has caught up (verify).
          </p>

          {dkimStatus.data?.publicRecord ? (
            <div className="flex items-start justify-between gap-2 rounded-sm border border-border-subtle bg-bg-inset px-2.5 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-caption text-text-muted">{dkimStatus.data.publicRecord.name}</p>
                <code className="block break-all font-mono-sm text-caption text-text-primary">
                  {dkimStatus.data.publicRecord.value}
                </code>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto shrink-0 p-1"
                onClick={() => void copyDkimRecord(dkimStatus.data?.publicRecord?.value ?? '')}
                aria-label="Copy DKIM record value"
              >
                <Copy className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          ) : (
            <p className="text-body-sm text-text-muted">
              No key has been generated yet for selector &quot;{selector}&quot;.
            </p>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dkim-keysize">Key size</Label>
              <select
                id="dkim-keysize"
                value={dkimKeysize}
                onChange={(event) => setDkimKeysize(Number(event.target.value) as DkimKeysize)}
                className="h-9 rounded-sm border border-border-default bg-bg-surface px-2.5 text-body-sm text-text-primary"
              >
                {DKIM_KEYSIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}-bit
                  </option>
                ))}
              </select>
            </div>
            <Button type="button" variant="secondary" onClick={() => setConfirmGenerateOpen(true)}>
              <KeyRound className="size-3.5" aria-hidden="true" />
              {dkimStatus.data?.publicRecord ? 'Rotate key' : 'Generate key'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmGenerateOpen}
        onOpenChange={setConfirmGenerateOpen}
        tier={2}
        title={dkimStatus.data?.publicRecord ? 'Rotate DKIM key' : 'Generate DKIM key'}
        description={
          dkimStatus.data?.publicRecord
            ? `A new key replaces the current one for selector "${selector}" on ${domain}. Mail signed with the old key may fail DKIM validation until the new DNS record has propagated — publish it as soon as this completes.`
            : `Generates a new ${dkimKeysize}-bit key for selector "${selector}" on ${domain}. You will need to publish the resulting DNS record before mail signed with it will validate.`
        }
        confirmLabel={dkimStatus.data?.publicRecord ? 'Rotate key' : 'Generate key'}
        pending={generateDkimMutation.isPending}
        onConfirm={handleGenerateConfirm}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-body font-semibold">DNS propagation</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-body-sm text-text-secondary">
            Queries a fixed list of independent public resolvers and shows what each currently
            answers. This is not a claim of global propagation — that cannot be observed from one
            vantage point.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="propagation-record-type">Record</Label>
              <select
                id="propagation-record-type"
                value={propagationType}
                onChange={(event) => {
                  setPropagationType(event.target.value as PropagationRecordType);
                  setPropagationRequested(false);
                }}
                className="h-9 rounded-sm border border-border-default bg-bg-surface px-2.5 text-body-sm text-text-primary"
              >
                {PROPAGATION_RECORD_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {RECORD_TYPE_LABEL[type]}
                  </option>
                ))}
              </select>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              pending={propagation.isFetching}
              onClick={() => setPropagationRequested(true)}
            >
              Check propagation
            </Button>
          </div>

          {propagationRequested && propagation.data ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-body-sm">
                <thead>
                  <tr className="border-b border-border-subtle text-left text-caption text-text-muted">
                    <th className="py-1.5 pr-3 font-medium">Resolver</th>
                    <th className="py-1.5 pr-3 font-medium">Address</th>
                    <th className="py-1.5 pr-3 font-medium">State</th>
                    <th className="py-1.5 font-medium">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {propagation.data.results.map((result) => (
                    <tr key={result.resolverAddress} className="border-b border-border-subtle/60">
                      <td className="py-1.5 pr-3">{result.resolverName}</td>
                      <td className="py-1.5 pr-3 font-mono-sm">{result.resolverAddress}</td>
                      <td className="py-1.5 pr-3">
                        <StatusBadge
                          status={
                            result.state === 'unknown'
                              ? 'unknown'
                              : result.state === 'missing'
                                ? 'warning'
                                : 'healthy'
                          }
                        />
                      </td>
                      <td className="py-1.5 break-all font-mono-sm">
                        {result.values.length > 0 ? result.values.join('; ') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
