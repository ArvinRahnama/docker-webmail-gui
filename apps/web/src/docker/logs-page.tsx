import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { ApiClientError, ApiError } from '@/lib/api-client';
import type { LogFileSource } from '@dwg/shared';
import { useContainerLogsQuery, useLogFileQuery } from './use-docker-queries';

type LogSource = 'container' | LogFileSource;

const SOURCES: readonly { readonly id: LogSource; readonly label: string }[] = [
  { id: 'container', label: 'Container output' },
  { id: 'mail', label: 'Mail log' },
  { id: 'fail2ban', label: 'Fail2ban log' },
];

/**
 * `/docker/logs` (M9 — FEATURE_MATRIX.md §19-21). Two independent
 * kinds of "logs": the managed container's own stdout/stderr, and a fixed
 * two-value enum of in-container log files. There is no free-text path
 * field anywhere on this page — the mail/fail2ban tabs are the entire
 * selection a client can make, matching `LogFileSource` (`@dwg/shared`).
 */
export function LogsPage() {
  const [source, setSource] = useState<LogSource>('container');

  const containerQuery = useContainerLogsQuery({ tail: 200 });
  const fileQuery = useLogFileQuery(source === 'container' ? 'mail' : source, 200);
  const activeQuery = source === 'container' ? containerQuery : fileQuery;

  const lines: readonly string[] =
    source === 'container'
      ? (containerQuery.data ?? []).map((line) => `[${line.stream}] ${line.data}`)
      : (fileQuery.data ?? []);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Logs"
        description="The last 200 lines of the mail container's own output, or a fixed diagnostic log file."
        action={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            pending={activeQuery.isFetching}
            onClick={() => void activeQuery.refetch()}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <div className="flex items-center gap-1 border-b border-border-default">
        {SOURCES.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setSource(item.id)}
            className={cn(
              'rounded-t-sm px-3 py-2 text-body-sm font-medium transition-colors duration-fast',
              source === item.id
                ? 'border-b-2 border-accent text-accent'
                : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="pt-6">
          {activeQuery.isError ? (
            <ErrorState
              message="Could not load this log."
              errorId={
                activeQuery.error instanceof ApiError || activeQuery.error instanceof ApiClientError
                  ? activeQuery.error.errorId
                  : 'unknown'
              }
              onRetry={() => void activeQuery.refetch()}
            />
          ) : activeQuery.isLoading ? (
            <Skeleton className="h-96 w-full" />
          ) : (
            <pre className="max-h-[32rem] overflow-auto rounded-sm bg-bg-inset p-3 font-mono-sm text-text-secondary">
              {lines.length > 0 ? lines.join('\n') : 'No log lines.'}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
