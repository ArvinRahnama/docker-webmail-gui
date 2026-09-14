import { Fragment, useState } from 'react';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import { BreakableText } from '@/components/breakable-text';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiClientError, ApiError } from '@/lib/api-client';
import type { ImageSummary } from '@dwg/shared';
import { useImagesQuery, usePruneImagesMutation } from './use-docker-queries';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatCreated(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleString();
}

/** Break points inside an image reference such as `ghcr.io/org/name:0.2.0`. */
const IMAGE_REF_SEPARATORS = '/:@._-';

/**
 * `/docker/images` (M9 — FEATURE_MATRIX.md §24). "Prune dangling images" is
 * the only mutation: it always removes every dangling (untagged, unused)
 * image and nothing else — there is no per-row delete action, matching the
 * broker protocol's `image.prune`, which takes no parameters at all and
 * has no by-id counterpart anywhere in this product.
 */
export function ImagesPage() {
  const query = useImagesQuery();
  const pruneMutation = usePruneImagesMutation();
  const [confirmPrune, setConfirmPrune] = useState(false);

  const columns: DataTableColumn<ImageSummary>[] = [
    {
      id: 'repoTags',
      header: 'Tags',
      sortValue: (row) => row.repoTags[0] ?? row.id,
      // A registry reference breaks after `/ : . -` (break-words, not
      // anywhere, so tags don't split mid-word), which keeps its minimum width
      // to one path segment: a long tag can no longer force the nowrap
      // columns past the table edge at 1024px.
      cellClassName: 'break-words',
      cell: (row) => (
        <>
          {row.repoTags.length > 0 ? (
            <span className="font-mono-sm">
              {row.repoTags.map((tag, index) => (
                <Fragment key={tag}>
                  {index > 0 ? ', ' : null}
                  <BreakableText text={tag} separators={IMAGE_REF_SEPARATORS} />
                </Fragment>
              ))}
            </span>
          ) : (
            <span className="text-text-muted">&lt;none&gt;</span>
          )}
          {/* Values of the columns hidden at this width move here: Image ID
              below lg, Created below sm. */}
          <span className="block text-caption text-text-muted lg:hidden">
            <span className="font-mono-sm">{row.id.slice(0, 19)}</span>
            <span className="sm:hidden"> · {formatCreated(row.createdAt)}</span>
          </span>
        </>
      ),
    },
    {
      id: 'id',
      header: 'Image ID',
      sortValue: (row) => row.id,
      // Short fixed-width values: keep them on one line so the auto-layout
      // table gives the spare width to Tags instead of wrapping "488.3 / MB".
      // Shown under the tags below lg instead: on a phone, and at md where
      // the sidebar leaves ~460px, its 19 unbreakable characters would squeeze
      // Tags into a tall column or add sideways scroll.
      headerClassName: 'hidden lg:table-cell',
      cellClassName: 'hidden whitespace-nowrap lg:table-cell',
      cell: (row) => (
        <span className="font-mono-sm text-text-secondary">{row.id.slice(0, 19)}</span>
      ),
    },
    {
      id: 'size',
      header: 'Size',
      sortValue: (row) => row.sizeBytes,
      cellClassName: 'whitespace-nowrap',
      cell: (row) => formatBytes(row.sizeBytes),
    },
    {
      id: 'created',
      header: 'Created',
      sortValue: (row) => row.createdAt,
      // Hidden on phones (shown under the tags). Unwrapped only from lg: on
      // narrower tables the extra width of an unwrapped timestamp would add
      // sideways scroll where the table used to fit.
      headerClassName: 'hidden sm:table-cell',
      cellClassName: 'hidden sm:table-cell lg:whitespace-nowrap',
      cell: (row) => formatCreated(row.createdAt),
    },
  ];

  if (query.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Images" description="Images used by your webmail stack." />
        <ErrorState
          message="Could not load the image list."
          errorId={
            query.error instanceof ApiError || query.error instanceof ApiClientError
              ? query.error.errorId
              : 'unknown'
          }
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Images"
        description="Images used by your webmail stack."
        action={
          <Button type="button" variant="secondary" onClick={() => setConfirmPrune(true)}>
            <Trash2 className="size-3.5" aria-hidden="true" />
            Prune dangling images
          </Button>
        }
      />

      {query.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <DataTable
          data={query.data ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          caption="Images used by your webmail stack"
          emptyState={
            <EmptyState
              variant="first-run"
              title="No images"
              description="No webmail images are visible on this host yet."
            />
          }
        />
      )}

      <ConfirmDialog
        open={confirmPrune}
        onOpenChange={setConfirmPrune}
        tier={2}
        title="Remove every dangling image?"
        description="Removes every untagged image not referenced by any container, running or stopped. An image still in use by any container is never removed."
        confirmLabel="Prune"
        pending={pruneMutation.isPending}
        onConfirm={() =>
          pruneMutation.mutate(undefined, {
            onSuccess: (result) => {
              setConfirmPrune(false);
              toast.success(
                result.imagesDeleted.length > 0
                  ? `Removed ${result.imagesDeleted.length} dangling image${result.imagesDeleted.length === 1 ? '' : 's'} (${formatBytes(result.spaceReclaimedBytes)} reclaimed)`
                  : 'No dangling images to remove',
              );
            },
            onError: () => toast.error('Could not prune images'),
          })
        }
      />
    </div>
  );
}
