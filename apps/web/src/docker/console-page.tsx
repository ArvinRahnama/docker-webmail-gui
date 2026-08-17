import { useState } from 'react';
import { toast } from 'sonner';
import { TerminalSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { UnsupportedNotice } from '@/components/unsupported-notice';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { CONSOLE_COMMANDS, type ConsoleCommand, type ConsoleExecResponse } from '@dwg/shared';
import { useConsoleAvailabilityQuery, useExecConsoleCommandMutation } from './use-docker-queries';

/** Labels only — the argv itself is entirely broker-owned (`apps/broker/src/operations.ts`); this map exists purely so the button text reads as a command rather than a raw enum key. */
const COMMAND_LABELS: Record<ConsoleCommand, string> = {
  'postqueue-p': 'postqueue -p',
  'postconf-n': 'postconf -n',
  'doveconf-n': 'doveconf -n',
  'doveadm-who': 'doveadm who',
};

/**
 * `/docker/console` (M9 — FEATURE_MATRIX.md §32). Behind
 * `ENABLE_EXEC_CONSOLE`, off by default — a real "disabled" state is
 * rendered via `UnsupportedNotice` rather than this route simply not
 * existing. Every button here corresponds to exactly one fixed,
 * zero-argument entry in `CONSOLE_COMMANDS` (`@dwg/shared`) — there is no
 * free-text command input anywhere on this page, matching the broker
 * protocol underneath it exactly.
 */
export function ConsolePage() {
  const availabilityQuery = useConsoleAvailabilityQuery();
  const execMutation = useExecConsoleCommandMutation();
  const [lastResult, setLastResult] = useState<ConsoleExecResponse | null>(null);

  if (availabilityQuery.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Console" description="Restricted, allowlisted diagnostic commands." />
        <ErrorState
          message="Could not check whether the console is available."
          errorId={
            availabilityQuery.error instanceof ApiError ||
            availabilityQuery.error instanceof ApiClientError
              ? availabilityQuery.error.errorId
              : 'unknown'
          }
          onRetry={() => void availabilityQuery.refetch()}
        />
      </div>
    );
  }

  if (availabilityQuery.isLoading || !availabilityQuery.data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Console" description="Restricted, allowlisted diagnostic commands." />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const capability = availabilityQuery.data;

  if (!capability.supported) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Console" description="Restricted, allowlisted diagnostic commands." />
        <UnsupportedNotice
          reason={capability.reason ?? 'The command console is disabled on this deployment.'}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Console"
        description="A fixed set of read-only diagnostic commands. There is no free-text command input — every option here is a real, pre-approved command with no arguments."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-body font-semibold">Run a command</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {CONSOLE_COMMANDS.map((command) => (
            <Button
              key={command}
              type="button"
              variant="secondary"
              pending={execMutation.isPending && execMutation.variables === command}
              disabled={execMutation.isPending}
              onClick={() =>
                execMutation.mutate(command, {
                  onSuccess: (result) => {
                    setLastResult(result);
                    toast[result.exitCode === 0 ? 'success' : 'error'](
                      `${COMMAND_LABELS[command]} exited ${result.exitCode}`,
                    );
                  },
                  onError: () => toast.error(`Could not run ${COMMAND_LABELS[command]}`),
                })
              }
            >
              <TerminalSquare className="size-3.5" aria-hidden="true" />
              {COMMAND_LABELS[command]}
            </Button>
          ))}
        </CardContent>
      </Card>

      {lastResult ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-body font-semibold">
              <span className="font-mono-sm">{lastResult.argv.join(' ')}</span> — exit code{' '}
              {lastResult.exitCode} ({lastResult.durationMs}ms)
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div>
              <p className="mb-1 text-caption text-text-muted">stdout</p>
              <pre className="max-h-64 overflow-auto rounded-sm bg-bg-inset p-3 font-mono-sm text-text-secondary">
                {lastResult.stdout || '(empty)'}
              </pre>
            </div>
            {lastResult.stderr ? (
              <div>
                <p className="mb-1 text-caption text-text-muted">stderr</p>
                <pre className="max-h-64 overflow-auto rounded-sm bg-status-warning-bg p-3 font-mono-sm text-status-warning-fg">
                  {lastResult.stderr}
                </pre>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
