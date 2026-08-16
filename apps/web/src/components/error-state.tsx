import { useState } from 'react';
import { AlertOctagon, Check, Copy, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

export interface ErrorStateProps {
  /** A human sentence — never the raw exception message. */
  readonly message: string;
  /** Selectable/copyable so an admin can quote it in a bug report (§9, §7) without needing to screenshot. */
  readonly errorId: string;
  /** Collapsed by default — technical detail (e.g. a stack trace's *text*, never rendered as markup) for someone who wants it, never shown unprompted. */
  readonly detail?: string;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  /** Affects padding/icon size only — every variant keeps the same message -> id -> detail -> recovery order (§9). */
  readonly variant?: 'inline' | 'page' | 'boundary';
  readonly className?: string;
}

/**
 * §9: "Human sentence, then error ID (selectable), then collapsible
 * technical detail, then a recovery action. Never a raw stack trace."
 * §2 principle 8: "Every error state names a next action." — `onRetry`
 * is optional in the type only because some errors genuinely have no
 * retry (e.g. a permanent 403); when there is a sensible next action, the
 * caller must supply it rather than this component inventing one.
 */
export function ErrorState({
  message,
  errorId,
  detail,
  onRetry,
  retryLabel = 'Try again',
  variant = 'inline',
  className,
}: ErrorStateProps) {
  const [copied, setCopied] = useState(false);

  const copyErrorId = () => {
    void navigator.clipboard
      .writeText(errorId)
      .then(() => {
        setCopied(true);
        toast.success('Error ID copied');
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        toast.error('Could not copy the error ID');
      });
  };

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center gap-3 rounded-md border border-border-default bg-bg-surface text-center',
        variant === 'page' ? 'px-6 py-16' : variant === 'boundary' ? 'px-6 py-10' : 'px-4 py-6',
        className,
      )}
    >
      <AlertOctagon
        className={cn('text-status-critical-fg', variant === 'page' ? 'size-10' : 'size-7')}
        aria-hidden="true"
      />

      <p className="max-w-md text-body font-medium text-text-primary">{message}</p>

      <button
        type="button"
        onClick={copyErrorId}
        className="inline-flex items-center gap-1.5 rounded-sm bg-bg-inset px-2 py-1 font-mono-sm text-text-secondary transition-colors duration-fast hover:text-text-primary"
      >
        <span className="select-all">{errorId}</span>
        {copied ? (
          <Check className="size-3.5 text-status-healthy-fg" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
        <span className="sr-only">{copied ? 'Copied' : 'Copy error ID'}</span>
      </button>

      {detail ? (
        <details className="w-full max-w-md text-left">
          <summary className="cursor-pointer text-caption font-medium text-text-muted transition-colors duration-fast hover:text-text-secondary">
            Technical detail
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-sm bg-bg-inset p-2 font-mono-sm text-text-secondary">
            {detail}
          </pre>
        </details>
      ) : null}

      {onRetry ? (
        <Button variant="secondary" onClick={onRetry} className="mt-1">
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
