import { AlertTriangle, ShieldCheck } from 'lucide-react';
import type { SpamIntegrationStatus } from '@dwg/shared';

/**
 * Whether the docker-mailserver side of the spam filter (docker/dms/) is
 * running. Without it nothing on these pages takes effect at delivery
 * time, so the pages say so plainly instead of looking like they work.
 */
export function SpamIntegrationNotice({
  integration,
}: {
  readonly integration: SpamIntegrationStatus | undefined;
}) {
  if (integration === undefined) return null;

  if (integration.installed) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-border-default bg-bg-surface px-4 py-3 text-body-sm text-text-secondary">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-status-healthy-fg" aria-hidden="true" />
        <p>
          Spam is never rejected on this server: it is delivered to the mailbox's{' '}
          <strong className="font-semibold text-text-primary">Junk</strong> folder. Moving a message
          out of Junk allows its sender for that mailbox; moving one into Junk blocks it. Viruses
          are still rejected.
        </p>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-status-warning-fg/30 bg-status-warning-bg px-4 py-3 text-body-sm text-status-warning-fg"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>
        The mail-server side of the spam filter is not installed, so Rspamd still rejects spam,
        these lists are not applied to incoming mail, and users' Junk moves are not picked up.
        Install it with <code className="font-mono-sm">installer/install-dms-integration.sh</code>{' '}
        (see <code className="font-mono-sm">docker/dms/README.md</code>), then recreate the mail
        server container.
      </p>
    </div>
  );
}
