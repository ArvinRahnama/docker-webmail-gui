import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CheckCircle2, Plus, Power, PowerOff, Save } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/error-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ApiClientError, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import {
  useActivateSieveScriptMutation,
  useDeactivateSieveScriptsMutation,
  usePutSieveScriptMutation,
  useSieveScriptQuery,
  useSieveScriptsQuery,
} from './use-security-queries';

const NEW_SCRIPT_TEMPLATE =
  'require ["fileinto"];\n\nif header :contains "subject" "" {\n  # your rule here\n}\n';

/**
 * `/security/sieve/:user` (FEATURE_MATRIX.md §17). Genuine per-mailbox
 * Sieve script management: list every stored script, edit one's content,
 * and choose which is active. The server rejects anything referencing
 * `vnd.dovecot.execute`/`sieve_pipe` before it is ever stored
 * (`drivers/dms/sieve-validator.ts`) — a rejection surfaces here as a
 * normal validation error, not a crash.
 */
export function SieveScriptsPage() {
  const { user: encodedUser } = useParams<{ user: string }>();
  const user = encodedUser ? decodeURIComponent(encodedUser) : '';

  const listQuery = useSieveScriptsQuery(user);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [creatingName, setCreatingName] = useState<string | null>(null);
  const [draftContent, setDraftContent] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const scriptQuery = useSieveScriptQuery(user, selectedName ?? '');
  const putMutation = usePutSieveScriptMutation(user);
  const activateMutation = useActivateSieveScriptMutation(user);
  const deactivateMutation = useDeactivateSieveScriptsMutation(user);

  useEffect(() => {
    if (selectedName && scriptQuery.data) setDraftContent(scriptQuery.data.content);
  }, [selectedName, scriptQuery.data]);

  const activeName = selectedName ?? creatingName;
  const isNewScript = creatingName !== null;

  const handleSave = () => {
    if (!activeName) return;
    setFormError(null);
    putMutation.mutate(
      { name: activeName, content: draftContent },
      {
        onSuccess: () => {
          toast.success(`Saved ${activeName}`);
          setCreatingName(null);
          setSelectedName(activeName);
        },
        onError: (err) => {
          setFormError(err instanceof ApiError ? err.message : 'Could not save this script.');
        },
      },
    );
  };

  if (listQuery.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Sieve filters" description={user} />
        <ErrorState
          message="Could not load Sieve scripts."
          errorId={
            listQuery.error instanceof ApiError || listQuery.error instanceof ApiClientError
              ? listQuery.error.errorId
              : 'unknown'
          }
          onRetry={() => void listQuery.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Sieve filters" description={user} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-body font-semibold">Scripts</CardTitle>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelectedName(null);
                setCreatingName('');
                setDraftContent(NEW_SCRIPT_TEMPLATE);
                setFormError(null);
                putMutation.reset();
              }}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              New
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 p-2">
            {listQuery.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : listQuery.data && listQuery.data.length > 0 ? (
              listQuery.data.map((script) => (
                <button
                  key={script.name}
                  type="button"
                  onClick={() => {
                    setCreatingName(null);
                    setSelectedName(script.name);
                    setFormError(null);
                    putMutation.reset();
                  }}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-sm px-2.5 py-2 text-left text-body-sm transition-colors duration-fast hover:bg-bg-inset',
                    selectedName === script.name
                      ? 'bg-accent-subtle-bg text-accent'
                      : 'text-text-primary',
                  )}
                >
                  <span className="truncate">{script.name}</span>
                  {script.active ? (
                    <Badge className="shrink-0 bg-status-healthy-bg text-status-healthy-fg">
                      Active
                    </Badge>
                  ) : null}
                </button>
              ))
            ) : (
              <p className="px-2.5 py-4 text-body-sm text-text-muted">No scripts yet.</p>
            )}
          </CardContent>
        </Card>

        {activeName === null ? (
          <Card>
            <CardContent className="flex h-full min-h-40 items-center justify-center text-body-sm text-text-muted">
              Choose a script on the left, or create a new one.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
              {isNewScript ? (
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="new-script-name">Script name</Label>
                  <Input
                    id="new-script-name"
                    value={creatingName ?? ''}
                    onChange={(event) => setCreatingName(event.target.value)}
                    placeholder="my-filter"
                    autoComplete="off"
                    autoFocus
                  />
                </div>
              ) : (
                <CardTitle className="text-body font-semibold">{activeName}</CardTitle>
              )}
              {!isNewScript && selectedName ? (
                <div className="flex shrink-0 gap-2">
                  {scriptQuery.data?.active ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      pending={deactivateMutation.isPending}
                      onClick={() =>
                        deactivateMutation.mutate(undefined, {
                          onSuccess: () => toast.success('Deactivated'),
                        })
                      }
                    >
                      <PowerOff className="size-3.5" aria-hidden="true" />
                      Deactivate
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      pending={activateMutation.isPending}
                      onClick={() =>
                        activateMutation.mutate(selectedName, {
                          onSuccess: () => toast.success(`Activated ${selectedName}`),
                        })
                      }
                    >
                      <Power className="size-3.5" aria-hidden="true" />
                      Activate
                    </Button>
                  )}
                </div>
              ) : null}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {!isNewScript && scriptQuery.isLoading ? (
                <Skeleton className="h-64 w-full" />
              ) : (
                <>
                  <Textarea
                    value={draftContent}
                    onChange={(event) => setDraftContent(event.target.value)}
                    className="min-h-72 font-mono-sm"
                    spellCheck={false}
                    aria-label="Sieve script content"
                  />
                  {formError ? (
                    <p className="text-body-sm text-status-critical-fg">{formError}</p>
                  ) : null}
                  <div className="flex items-center gap-3">
                    <Button
                      type="button"
                      variant="primary"
                      pending={putMutation.isPending}
                      disabled={isNewScript && creatingName?.trim().length === 0}
                      onClick={handleSave}
                    >
                      <Save className="size-3.5" aria-hidden="true" />
                      Save
                    </Button>
                    {putMutation.isSuccess && !formError ? (
                      <span className="inline-flex items-center gap-1 text-body-sm text-status-healthy-fg">
                        <CheckCircle2 className="size-3.5" aria-hidden="true" />
                        Saved
                      </span>
                    ) : null}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
