import type { LucideIcon } from 'lucide-react';
import { FilterX, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';

interface EmptyStateAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface FirstRunEmptyStateProps {
  readonly variant: 'first-run';
  readonly icon?: LucideIcon;
  readonly title: string;
  readonly description: string;
  /** The primary creating action — first-run is the only variant that ever offers one (§9). */
  readonly action?: EmptyStateAction;
  readonly className?: string;
}

export interface FilteredEmptyStateProps {
  readonly variant: 'filtered';
  /** The active filters, as human-readable labels (e.g. "Domain: example.com") — shown so the admin can see *why* nothing matched. */
  readonly activeFilters: readonly string[];
  readonly onClearFilters: () => void;
  readonly className?: string;
}

export type EmptyStateProps = FirstRunEmptyStateProps | FilteredEmptyStateProps;

/**
 * §9: "Empty — first run" and "Empty — filtered" are deliberately
 * different designs, not the same component with different copy —
 * first-run explains what the thing is and offers the creating action;
 * filtered shows what's filtering the list to nothing and offers only
 * *Clear filters*, "which would be the wrong offer" for a create action
 * here (data already exists, just not visible under the current filter).
 */
export function EmptyState(props: EmptyStateProps) {
  if (props.variant === 'first-run') {
    const Icon = props.icon ?? Inbox;
    return (
      <div
        className={cn(
          'flex flex-col items-center gap-3 rounded-md border border-dashed border-border-default bg-bg-surface px-6 py-12 text-center',
          props.className,
        )}
      >
        <Icon className="size-10 text-text-muted" aria-hidden="true" />
        <h2 className="text-h2 font-semibold text-text-primary">{props.title}</h2>
        <p className="max-w-md text-body-sm text-text-secondary">{props.description}</p>
        {props.action ? (
          <Button variant="primary" onClick={props.action.onClick} className="mt-2">
            {props.action.label}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-md border border-border-subtle bg-bg-inset px-6 py-10 text-center',
        props.className,
      )}
    >
      <FilterX className="size-8 text-text-muted" aria-hidden="true" />
      <h2 className="text-h3 font-semibold text-text-primary">No results match your filters</h2>
      {props.activeFilters.length > 0 ? (
        <ul className="flex flex-wrap justify-center gap-1.5" aria-label="Active filters">
          {props.activeFilters.map((filter) => (
            <li key={filter}>
              <Badge variant="outline">{filter}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <Button variant="ghost" onClick={props.onClearFilters} className="mt-1">
        Clear filters
      </Button>
    </div>
  );
}
