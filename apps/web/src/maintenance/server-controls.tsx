import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, RotateCw, ServerCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ApiError } from '@/lib/api-client';
import { pingHealth, restartPanel } from '@/lib/docker-api';
import { useRestartContainerMutation } from '@/docker/use-docker-queries';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Let the server actually begin going down before the first health probe — otherwise a probe issued while it is still up would count as "already back". In development (fake broker) the server never goes down, so this is just a brief "restarting" beat. */
const GO_DOWN_GRACE_MS = 2_000;
const POLL_INTERVAL_MS = 1_500;
const RECONNECT_TIMEOUT_MS = 90_000;

/**
 * The two restart controls the Configuration page carries (FEATURE_MATRIX.md
 * §22). Both are Tier-2 confirmed operations:
 *
 * - **Restart mail server** — the managed docker-mailserver container, via
 *   the existing `container.restart`. Ordinary mutation.
 * - **Restart panel** — the panel's own server container, via the new
 *   `panel.restart`. This one takes *this* server down, so the request that
 *   triggers it is expected to be dropped: instead of waiting on it, the UI
 *   shows a blocking "reconnecting" overlay and polls `/api/v1/health` until
 *   the server answers again. A structured API error (the broker refusing —
 *   e.g. an unresolved panel-server identity) means the server stayed up and
 *   did not restart, so that is surfaced directly rather than polled on.
 */
export function ServerControls() {
  const restartMail = useRestartContainerMutation();
  const [confirm, setConfirm] = useState<'mail' | 'panel' | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  // Guards against a second panel restart being launched while one is
  // already in flight (the overlay blocks clicks, but this is the source of
  // truth the async flow reads).
  const inFlight = useRef(false);

  const doRestartMail = () => {
    restartMail.mutate(undefined, {
      onSuccess: () => {
        setConfirm(null);
        toast.success('Mail server restarted.');
      },
      onError: () => toast.error('Could not restart the mail server.'),
    });
  };

  const doRestartPanel = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setConfirm(null);
    setReconnecting(true);

    // Fire the restart but never block on it: in production the connection
    // drops as the server dies (an ApiClientError, expected), while the
    // broker refusing arrives as a structured ApiError we must surface.
    let refusal: string | null = null;
    void restartPanel().catch((err: unknown) => {
      if (err instanceof ApiError) refusal = err.message;
    });

    await delay(GO_DOWN_GRACE_MS);

    let recovered = false;
    const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (refusal !== null) break;
      if (await pingHealth()) {
        recovered = true;
        break;
      }
      await delay(POLL_INTERVAL_MS);
    }

    setReconnecting(false);
    inFlight.current = false;

    if (refusal !== null) {
      toast.error(refusal);
    } else if (recovered) {
      toast.success('The panel is back online.');
    } else {
      toast.error('The panel did not respond within 90 seconds. Reload the page to check on it.');
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <ServerCog className="size-4 text-text-muted" aria-hidden="true" />
          <CardTitle className="text-body font-semibold">Server controls</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-body-sm text-text-secondary">
            Restart the mail server or this panel. Each briefly interrupts the service it names;
            restarting the panel disconnects you for a few seconds while it comes back.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setConfirm('mail')}
              disabled={restartMail.isPending}
            >
              <RotateCw className="size-3.5" aria-hidden="true" />
              Restart mail server
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setConfirm('panel')}
              disabled={reconnecting}
            >
              <RotateCw className="size-3.5" aria-hidden="true" />
              Restart panel
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirm === 'mail'}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        tier={2}
        title="Restart the mail server?"
        description="Mail delivery, IMAP/POP3 access and every feature that depends on the mail container will be briefly unavailable while it restarts."
        confirmLabel="Restart"
        pending={restartMail.isPending}
        onConfirm={doRestartMail}
      />

      <ConfirmDialog
        open={confirm === 'panel'}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        tier={2}
        title="Restart the panel?"
        description="This restarts the panel's own server. You will be disconnected for a few seconds; this page reconnects automatically once it is back."
        confirmLabel="Restart panel"
        onConfirm={() => void doRestartPanel()}
      />

      {reconnecting ? (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="restart-panel-title"
          aria-describedby="restart-panel-desc"
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg-overlay p-4"
        >
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-lg border border-border-default bg-bg-surface p-8 text-center shadow-md">
            <Loader2 className="size-8 animate-spin text-accent" aria-hidden="true" />
            <h2 id="restart-panel-title" className="text-h2 font-semibold text-text-primary">
              Restarting the panel
            </h2>
            <p
              id="restart-panel-desc"
              className="text-body-sm text-text-secondary"
              aria-live="polite"
            >
              The panel is briefly unavailable while its server restarts. This page reconnects
              automatically.
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}
