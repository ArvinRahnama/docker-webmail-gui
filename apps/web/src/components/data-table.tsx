import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  createColumnHelper,
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
  type RowData,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';

/**
 * `DataTable` — the one table component every list screen in this app
 * uses (UX_ARCHITECTURE.md §7's component inventory: "TanStack Table
 * (headless) + custom"). Sorting and pagination are delegated to
 * `@tanstack/react-table` v9's row-model machinery — real sort
 * comparators and real pagination math, not hand-rolled slicing; row
 * selection (used for bulk mailbox actions) is deliberately plain
 * controlled React state instead, since it is fully owned by the caller
 * (`selectedIds`/`onSelectedIdsChange`) and wiring a second stateful
 * TanStack feature would add API surface without adding correctness.
 *
 * Only one `features` registry is ever created (module scope, not
 * per-render or per-instance) — `tableFeatures()` output does not depend
 * on the row type, so every `DataTable<T>` instance, whatever `T` is,
 * shares it.
 *
 * `sortFns` must be registered explicitly in v9 — unlike v8, where
 * `alphanumeric`/`text`/`basic`/`datetime` were built in and just worked.
 * Every string-valued column here defaults to `sortFn: 'auto'`
 * (`rowSortingFeature`'s own column-def default; no column below sets it),
 * which samples the column's values and picks `'alphanumeric'` for a mixed
 * text/digit string (most addresses, IDs, and ISO timestamps in this app)
 * or `'text'` for a pure-alphabetic one — then looks *that name* up in
 * here. Leaving this empty doesn't disable sorting (`column_getAutoSortFn`
 * still falls through to `sortFn_basic`, a raw `>` comparison, so a header
 * click does reorder rows) — it silently swaps in the wrong comparator:
 * case-sensitive (every "Z" sorts before every "a") and lexical rather
 * than natural ("item10" sorts before "item2"). Confirmed both ways by two
 * tests in data-table.test.tsx that fail without this registration and
 * pass with it — `sortFn_basic` itself needs no entry here; it's
 * table-core's own hardcoded last-resort, not something `sortFns` looks up
 * by name.
 */
const features = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
});

export interface DataTableColumn<T extends RowData> {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: T) => ReactNode;
  /** Present => sortable, using this as the sort key. Absent => not sortable, no header button. */
  readonly sortValue?: (row: T) => string | number;
  readonly headerClassName?: string;
  readonly cellClassName?: string;
}

export interface DataTableProps<T extends RowData> {
  readonly data: readonly T[];
  readonly columns: readonly DataTableColumn<T>[];
  readonly getRowId: (row: T) => string;
  /** Caption for screen readers — every table names what it is, not just what's in it (§11). */
  readonly caption: string;
  /**
   * Rendered in place of the table body when `data` is empty. Callers
   * decide first-run vs filtered-empty (§9) — this component has no
   * opinion on which the caller is in.
   */
  readonly emptyState: ReactNode;
  readonly pageSize?: number;
  readonly isLoading?: boolean;
  // Explicit `| undefined` (not a bare optional): callers conditionally
  // pass these as `condition ? value : undefined` (e.g. hiding selection
  // when a capability is unsupported), which exactOptionalPropertyTypes
  // treats differently from the key being absent altogether.
  readonly selectedIds?: ReadonlySet<string> | undefined;
  readonly onSelectedIdsChange?: ((ids: ReadonlySet<string>) => void) | undefined;
  readonly rowActions?: ((row: T) => ReactNode) | undefined;
  readonly initialSort?: { readonly id: string; readonly desc: boolean };
}

function SortIcon({ direction }: { direction: false | 'asc' | 'desc' }) {
  if (direction === 'asc') return <ArrowUp className="size-3.5" aria-hidden="true" />;
  if (direction === 'desc') return <ArrowDown className="size-3.5" aria-hidden="true" />;
  return <ArrowUpDown className="size-3.5 opacity-40" aria-hidden="true" />;
}

function ariaSortFor(direction: false | 'asc' | 'desc'): 'ascending' | 'descending' | 'none' {
  if (direction === 'asc') return 'ascending';
  if (direction === 'desc') return 'descending';
  return 'none';
}

const DEFAULT_PAGE_SIZE = 25;

export function DataTable<T extends RowData>({
  data,
  columns,
  getRowId,
  caption,
  emptyState,
  pageSize = DEFAULT_PAGE_SIZE,
  isLoading = false,
  selectedIds,
  onSelectedIdsChange,
  rowActions,
  initialSort,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(
    initialSort ? [{ id: initialSort.id, desc: initialSort.desc }] : [],
  );
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize });

  // Keep static inputs (columns) stable across renders — a fresh column
  // array every render would invalidate the sorted/paginated row models
  // for no reason (the getting-started skill's own "keep static inputs
  // outside render" pattern).
  const columnDefs = useMemo(() => {
    const helper = createColumnHelper<typeof features, T>();
    return columns.map((column) =>
      column.sortValue
        ? // Return type pinned to `unknown` (matching `helper.display`'s
          // own TValue below) purely so both branches of this ternary
          // produce the same column-def type and TypeScript can unify
          // them into one array — the cell renderer never reads
          // `ctx.getValue()` anyway (it always calls `column.cell` with
          // the original row), and TanStack's automatic sort-function
          // detection inspects the actual runtime value, not this
          // static type, so sorting behaviour is unaffected.
          helper.accessor((row): unknown => column.sortValue!(row), {
            id: column.id,
            header: column.header,
            cell: (ctx) => column.cell(ctx.row.original),
            // Forced explicitly: TanStack's own default is to guess
            // per-column from the first value's type (numeric columns
            // default to descending-first). Every table in this app
            // should behave identically on the first header click
            // regardless of what a column happens to contain — an admin
            // scanning many different tables should never have to
            // remember "quota sorts backwards".
            sortDescFirst: false,
          })
        : helper.display({
            id: column.id,
            header: column.header,
            cell: (ctx) => column.cell(ctx.row.original),
            enableSorting: false,
          }),
    );
    // Intentionally `[]`: `columns` is treated as a stable prop identity by
    // every caller (defined at module scope), matching the getting-started
    // skill's own "keep static inputs outside render" guidance above. No
    // react-hooks lint rule is configured in this project to flag this.
  }, []);

  const table = useTable({
    features,
    columns: columnDefs,
    data: data as T[],
    getRowId,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
  });

  const selectable = selectedIds !== undefined && onSelectedIdsChange !== undefined;
  const rows = table.getRowModel().rows;
  const pageRowIds = rows.map((row) => row.id);
  const allPageRowsSelected =
    selectable && pageRowIds.length > 0 && pageRowIds.every((id) => selectedIds.has(id));
  const somePageRowsSelected = selectable && pageRowIds.some((id) => selectedIds.has(id));

  function toggleRow(id: string, checked: boolean) {
    if (!selectable) return;
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectedIdsChange(next);
  }

  function toggleAllOnPage(checked: boolean) {
    if (!selectable) return;
    const next = new Set(selectedIds);
    for (const id of pageRowIds) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    onSelectedIdsChange(next);
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2" role="status" aria-label="Loading table data">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  if (data.length === 0) {
    return <>{emptyState}</>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-md border border-border-default">
        <table className="w-full border-collapse text-body-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-border-subtle bg-bg-inset">
                {selectable ? (
                  <th scope="col" className="w-10 px-3 py-2 text-left">
                    <Checkbox
                      checked={
                        allPageRowsSelected ? true : somePageRowsSelected ? 'indeterminate' : false
                      }
                      onCheckedChange={(checked) => toggleAllOnPage(checked === true)}
                      aria-label="Select all rows on this page"
                    />
                  </th>
                ) : null}
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const direction = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={canSort ? ariaSortFor(direction) : undefined}
                      className="px-3 py-2 text-left font-semibold text-text-secondary"
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="inline-flex items-center gap-1 rounded-sm text-left transition-colors duration-fast hover:text-text-primary"
                        >
                          <table.FlexRender header={header} />
                          <SortIcon direction={direction} />
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </th>
                  );
                })}
                {rowActions ? (
                  <th scope="col" className="w-10 px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className="border-b border-border-subtle last:border-0 hover:bg-bg-inset"
              >
                {selectable ? (
                  <td className="px-3 py-2">
                    <Checkbox
                      checked={selectedIds.has(row.id)}
                      onCheckedChange={(checked) => toggleRow(row.id, checked === true)}
                      aria-label={`Select row ${row.id}`}
                    />
                  </td>
                ) : null}
                {row.getAllCells().map((cell) => {
                  const columnDef = columns.find((c) => c.id === cell.column.id);
                  return (
                    <td
                      key={cell.id}
                      className={cn(
                        'px-3 py-2 align-middle text-text-primary',
                        columnDef?.cellClassName,
                      )}
                    >
                      <table.FlexRender cell={cell} />
                    </td>
                  );
                })}
                {rowActions ? (
                  <td className="px-3 py-2 text-right">{rowActions(row.original)}</td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-caption text-text-muted">
        <span>
          Page {table.state.pagination.pageIndex + 1} of {Math.max(1, table.getPageCount())} ·{' '}
          {data.length} total
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="inline-flex size-7 items-center justify-center rounded-sm border border-border-default disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Previous page"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="inline-flex size-7 items-center justify-center rounded-sm border border-border-default disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Next page"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
