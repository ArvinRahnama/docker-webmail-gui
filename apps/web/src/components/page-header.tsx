import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
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
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        {Icon ? (
          <span
            className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-accent-subtle-bg text-accent"
            aria-hidden="true"
          >
            <Icon className="size-5" />
          </span>
        ) : null}
        <div>
          <h1 className="text-h1 font-semibold text-text-primary">{title}</h1>
          {description ? (
            <p className="mt-1 text-body-sm text-text-secondary">{description}</p>
          ) : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
