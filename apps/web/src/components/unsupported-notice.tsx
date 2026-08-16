import type { ReactNode } from 'react';
import { ExternalLink, HelpCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';

interface UnsupportedNoticeBase {
  /** Why this deployment can't do it — e.g. "docker-mailserver has no `setup domain` command." Always shown; never just "Unsupported" on its own (§9). */
  readonly reason: string;
  readonly docsHref?: string;
  readonly className?: string;
}

export interface InlineUnsupportedNoticeProps extends UnsupportedNoticeBase {
  readonly variant?: 'inline';
}

export interface TooltipUnsupportedNoticeProps extends UnsupportedNoticeBase {
  readonly variant: 'tooltip';
  /** The disabled control itself. Wrapped in a focusable/hoverable span — a native `disabled` element fires neither focus nor hover events in most browsers, which would make the explanation unreachable by keyboard or on touch. */
  readonly children: ReactNode;
}

export type UnsupportedNoticeProps = InlineUnsupportedNoticeProps | TooltipUnsupportedNoticeProps;

/**
 * §8/§9's "Unsupported" state: "Control is visible but disabled, with a
 * short explanation and a docs link. We neither hide it (the admin then
 * hunts for it) nor fake it." This component is the one place that
 * pattern is implemented, so every screen applies it identically rather
 * than improvising (§9: "gets a dedicated component so it is applied
 * consistently").
 */
export function UnsupportedNotice(props: UnsupportedNoticeProps) {
  if (props.variant === 'tooltip') {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className={cn('inline-flex cursor-not-allowed', props.className)}>
              {props.children}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            <NoticeBody reason={props.reason} docsHref={props.docsHref} compact />
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-sm border border-border-subtle bg-bg-inset px-3 py-2 text-body-sm text-text-secondary',
        props.className,
      )}
    >
      <HelpCircle className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true" />
      <NoticeBody reason={props.reason} docsHref={props.docsHref} />
    </div>
  );
}

function NoticeBody({
  reason,
  docsHref,
  compact = false,
}: {
  reason: string;
  // Explicitly `| undefined` rather than a bare optional: the project sets
  // `exactOptionalPropertyTypes`, under which an optional property may be
  // *absent* but may not be *passed as undefined*. Callers here forward an
  // optional prop straight through, so the type has to admit the value they
  // actually pass.
  docsHref?: string | undefined;
  compact?: boolean | undefined;
}) {
  return (
    <span className={cn('flex flex-col gap-1', compact && 'text-caption')}>
      <span>{reason}</span>
      {docsHref ? (
        <a
          href={docsHref}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline"
        >
          Learn more
          <ExternalLink className="size-3" aria-hidden="true" />
        </a>
      ) : null}
    </span>
  );
}
