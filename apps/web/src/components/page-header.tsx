import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { BreakableText } from '@/components/breakable-text';
import { useResolvedPageIcon } from '@/layout/page-chrome';

export interface PageHeaderProps {
  readonly title: string;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  /**
   * Overrides the icon otherwise resolved from the current route
   * (`page-chrome.tsx`). Pass `null` to render no icon on a page where one
   * would be resolved but is unwanted.
   */
  readonly icon?: LucideIcon | null | undefined;
}

/**
 * UX_ARCHITECTURE.md §5.3: "Page header: title, one-line description,
 * primary action right-aligned." The leading icon (v0.1 design pass) is
 * the same glyph the sidebar uses for this section — resolved from the
 * route by default so every page is consistent without naming it, and
 * decorative (`aria-hidden`) since the `<h1>` already carries the name.
 */
export function PageHeader({ title, description, action, icon }: PageHeaderProps) {
  const resolvedIcon = useResolvedPageIcon();
  const Icon = icon === undefined ? resolvedIcon : icon;

  return (
    // min-w-0 + overflow-wrap:anywhere: titles and descriptions often carry
    // user data (a mailbox address, a domain) with no break opportunity.
    // Without them that one word sets the flex items' minimum width and
    // widens the whole page on a phone. BreakableText gives such a title
    // real break points after `@`, `.`, `_` and `-`, so it wraps as
    // `contosopharmaceuticals.` / `com` rather than orphaning `om`;
    // overflow-wrap:anywhere stays as the fallback for a single label wider
    // than the line. The action wrapper is likewise allowed to shrink, so a
    // group of header buttons wraps instead.
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        {Icon ? (
          <span
            className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-accent-subtle-bg text-accent"
            aria-hidden="true"
          >
            <Icon className="size-5" />
          </span>
        ) : null}
        <div className="min-w-0">
          <h1 className="text-h1 font-semibold text-text-primary [overflow-wrap:anywhere]">
            <BreakableText text={title} />
          </h1>
          {description ? (
            <p className="mt-1 text-body-sm text-text-secondary [overflow-wrap:anywhere]">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {action ? <div className="min-w-0 max-w-full">{action}</div> : null}
    </div>
  );
}
