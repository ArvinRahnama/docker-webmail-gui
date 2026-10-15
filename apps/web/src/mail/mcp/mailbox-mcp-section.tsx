/**
 * Compact MCP card on the mailbox detail page: this mailbox's credential
 * binding, its connections, and a shortcut to generate one. Renders nothing
 * at all when the MCP integration is not deployed, so installs without it
 * see an unchanged page.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Plus } from 'lucide-react';
import type { CreateMcpConnectionResponse } from '@dwg/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/status/status-badge';
import { CreateConnectionDialog } from './create-connection-dialog';
import { OneTimeCredentialDialog } from './one-time-credential-dialog';
import { CONNECTION_STATUS_DISPLAY, CREDENTIAL_HEALTH_DISPLAY, formatEventDate } from './mcp-ui';
import { useMcpMailboxOverviewQuery, useMcpStatusQuery } from './use-mcp-queries';

export function MailboxMcpSection({ mailbox }: { mailbox: string }) {
  const navigate = useNavigate();
  const status = useMcpStatusQuery();
  const deployed = status.data?.deployed === true;
  const overview = useMcpMailboxOverviewQuery(mailbox, deployed);
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreateMcpConnectionResponse | null>(null);

  if (!deployed) return null;
  const enabled = status.data?.service?.enabled === true;
  const binding = overview.data?.binding ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Bot className="size-4" aria-hidden="true" />
            MCP access
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={!enabled}
            onClick={() => setCreateOpen(true)}
          >
            <Plus aria-hidden="true" />
            Generate connection
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {overview.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-2 text-body-sm text-text-secondary">
              IMAP/SMTP credential:
              {binding ? (
                <StatusBadge
                  status={CREDENTIAL_HEALTH_DISPLAY[binding.credentialHealth].status}
                  label={CREDENTIAL_HEALTH_DISPLAY[binding.credentialHealth].label}
                />
              ) : (
                <StatusBadge status="unknown" label="Not provisioned" />
              )}
            </p>
            {(overview.data?.connections ?? []).length === 0 ? (
              <p className="text-body-sm text-text-muted">No MCP connections for this mailbox.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border-subtle">
                {overview.data?.connections.map((connection) => (
                  <li
                    key={connection.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-body-sm"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-text-primary">{connection.label}</p>
                      <p className="text-caption text-text-muted">
                        Last activity {formatEventDate(connection.lastUsedAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge
                        status={CONNECTION_STATUS_DISPLAY[connection.status].status}
                        label={CONNECTION_STATUS_DISPLAY[connection.status].label}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => navigate(`/mail/mcp/${connection.id}`)}
                      >
                        Manage
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
      <CreateConnectionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initialMailbox={mailbox}
        onCreated={setCreated}
      />
      <OneTimeCredentialDialog
        title="Connection generated"
        credential={created?.oneTimeCredential ?? null}
        mailbox={mailbox}
        mcpUrl={created?.connection.mcpUrl ?? null}
        permissions={created?.connection.permissions ?? []}
        onClose={() => setCreated(null)}
      />
    </Card>
  );
}
