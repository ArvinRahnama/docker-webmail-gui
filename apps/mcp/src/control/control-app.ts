/**
 * The internal control API — the only way to manage MCP connections.
 *
 * Never bound to a socket: the panel's server process reaches it in-process
 * (`startEmbeddedMcp().control`). Every route still requires the per-process
 * control secret (`config.controlSecret`, compared in constant time) and
 * validates its input, so this boundary does not depend on how it is
 * reached. The panel calls it only from routes guarded by an admin session,
 * CSRF and the `mcp:manage` permission, and passes the acting postmaster's
 * identity for the MCP-side audit trail.
 */
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import {
  MCP_CONTROL_AUTH_HEADER,
  MCP_CONTROL_PROTOCOL_VERSION,
  McpConnectionIdSchema,
  McpConnectionListQuerySchema,
  McpControlActorRequestSchema,
  McpControlCreateConnectionRequestSchema,
  McpControlMailboxEventRequestSchema,
  McpControlReconcileRequestSchema,
  McpControlSettingsPatchRequestSchema,
  McpControlUpdateConnectionRequestSchema,
  McpControlUpdateCredentialsRequestSchema,
  McpMailboxAddressSchema,
  type McpDiscoveryCheckResponse,
  type McpServiceStatus,
  type McpSettings,
  type McpSettingsResponse,
} from '@dwg/shared';
import { z } from 'zod';
import type { Services } from '../services.js';
import { ControlError, createControlErrorHandler, parseWith } from '../platform/errors.js';
import { timingSafeEqualString } from '../crypto/random.js';
import { isValidBaseUrl } from '../config.js';
import { buildAuthorizationServerMetadata, endpointsFor } from '../oauth/endpoints.js';

export function settingsWarnings(settings: McpSettings, services: Services): string[] {
  const warnings: string[] = [];
  if (settings.publicBaseUrl === null)
    warnings.push('No public MCP URL is set; connections cannot be generated until one is.');
  else if (!settings.publicBaseUrl.startsWith('https://')) {
    warnings.push(
      'The public MCP URL is not https://. OAuth and MCP endpoints must be served over HTTPS in production.',
    );
  }
  if (!settings.mail.tlsVerify)
    warnings.push(
      'Mail-server certificate verification is disabled. Credentials could be intercepted on the path to the mail server.',
    );
  if (!services.vault.available)
    warnings.push('No credential vault key is configured; mailbox credentials cannot be stored.');
  if (
    !settings.clientRegistration.dynamicRegistration &&
    !settings.clientRegistration.metadataDocuments
  ) {
    warnings.push('Both client registration methods are disabled; no MCP client can authorize.');
  }
  if (services.mail.kind === 'fake')
    warnings.push('The development fake mail backend is active; no real mailbox is accessed.');
  return warnings;
}

const IdParams = z.object({ id: McpConnectionIdSchema });
const GrantParams = z.object({
  id: McpConnectionIdSchema,
  grantId: z.string().regex(/^gr_[0-9a-z]{26}$/),
});

export async function buildControlApp(
  services: Services,
  logger: Logger,
): Promise<FastifyInstance> {
  const app = Fastify<Server, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: logger,
    bodyLimit: 16 * 1024 * 1024,
  });
  app.setErrorHandler(createControlErrorHandler(logger));

  app.get('/healthz', async (_request, reply) => {
    void reply.send({ status: 'ok' });
  });

  await app.register(
    async (control) => {
      control.addHook('onRequest', async (request) => {
        const presented = request.headers[MCP_CONTROL_AUTH_HEADER];
        if (
          typeof presented !== 'string' ||
          !timingSafeEqualString(presented, services.config.controlSecret)
        ) {
          throw new ControlError('UNAUTHENTICATED', 'Control API authentication failed.');
        }
      });

      const settingsResponse = (): McpSettingsResponse => {
        const settings = services.settings.get();
        return {
          settings,
          issuer: settings.publicBaseUrl,
          warnings: settingsWarnings(settings, services),
        };
      };

      control.get('/status', async (_request, reply) => {
        const settings = services.settings.get();
        const status: McpServiceStatus = {
          version: services.config.version,
          controlProtocolVersion: MCP_CONTROL_PROTOCOL_VERSION,
          uptimeSeconds: Math.max(
            0,
            (services.clock.now().getTime() - services.startedAt.getTime()) / 1000,
          ),
          enabled: settings.enabled,
          publicBaseUrl: settings.publicBaseUrl,
          issuer: settings.publicBaseUrl,
          vault: services.vault.available ? 'ok' : 'missing_key',
          mailBackend: services.mail.kind,
          counts: services.connections.counts(),
          recentEvents: services.audit.list({ limit: 20 }),
          recentFailures: services.audit.list({ limit: 10, failuresOnly: true }),
        };
        // A key that differs from every stored ciphertext's key id is a mismatch.
        if (status.vault === 'ok') {
          const mismatch = services.db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM mcp_credentials WHERE key_id <> ?',
            [services.vault.keyId],
          );
          if (Number(mismatch?.n ?? 0) > 0) status.vault = 'key_mismatch';
        }
        void reply.send(status);
      });

      control.get('/settings', async (_request, reply) => {
        void reply.send(settingsResponse());
      });

      control.patch('/settings', async (request, reply) => {
        const body = parseWith(McpControlSettingsPatchRequestSchema, request.body);
        const patch = body.patch;
        if (patch.publicBaseUrl !== undefined && patch.publicBaseUrl !== null) {
          if (!isValidBaseUrl(patch.publicBaseUrl)) {
            throw new ControlError(
              'VALIDATION_FAILED',
              'The public URL must be an origin only, e.g. https://mcp.example.com (no path or trailing slash).',
            );
          }
          if (services.config.requireHttps && !patch.publicBaseUrl.startsWith('https://')) {
            throw new ControlError('VALIDATION_FAILED', 'The public URL must use https://.');
          }
        }
        const before = services.settings.get();
        if (patch.enabled === true && (patch.publicBaseUrl ?? before.publicBaseUrl) === null) {
          throw new ControlError(
            'VALIDATION_FAILED',
            'Set the public MCP URL before enabling MCP.',
          );
        }
        services.settings.update(patch, services.clock.now().toISOString());
        services.audit.record({
          event: 'settings.updated',
          result: 'success',
          actor: `postmaster:${body.actor}`,
          details: { fields: Object.keys(patch).join(','), enabled: patch.enabled ?? null },
        });
        void reply.send(settingsResponse());
      });

      control.post('/discovery-check', async (_request, reply) => {
        const settings = services.settings.get();
        const checks: McpDiscoveryCheckResponse['checks'] = [];
        if (settings.publicBaseUrl === null) {
          checks.push({ check: 'public-url', ok: false, message: 'No public URL is configured.' });
        } else {
          const https = settings.publicBaseUrl.startsWith('https://');
          checks.push({
            check: 'public-url',
            ok: https,
            message: https
              ? `Public URL ${settings.publicBaseUrl}`
              : 'The public URL is not https://.',
          });
          const expected = buildAuthorizationServerMetadata(settings);
          const endpoints = endpointsFor(settings.publicBaseUrl);
          checks.push({
            check: 'issuer-consistency',
            ok: expected !== null && expected['issuer'] === endpoints.issuer,
            message:
              'Issuer, protected-resource authorization_servers and the iss response parameter all use the same string.',
          });
          checks.push({
            check: 'service-enabled',
            ok: settings.enabled,
            message: settings.enabled
              ? 'MCP is enabled.'
              : 'MCP is disabled, so discovery endpoints answer 404.',
          });
          // Live probe of our own public URL through the operator's reverse proxy.
          // Only a pass/fail comparison is reported, never the fetched content.
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            const response = await fetch(
              `${settings.publicBaseUrl}/.well-known/oauth-authorization-server`,
              {
                signal: controller.signal,
                redirect: 'manual',
                headers: { accept: 'application/json' },
              },
            );
            clearTimeout(timer);
            const json = (await response.json().catch(() => null)) as Record<
              string,
              unknown
            > | null;
            const okLive =
              response.status === 200 && json !== null && json['issuer'] === endpoints.issuer;
            checks.push({
              check: 'live-discovery',
              ok: okLive,
              message: okLive
                ? 'The authorization-server metadata is reachable through the public URL and matches.'
                : `The public URL answered HTTP ${response.status}${json === null ? ' without JSON' : ''}; check the reverse proxy routes it to apps/mcp.`,
            });
          } catch {
            checks.push({
              check: 'live-discovery',
              ok: false,
              message:
                'Could not fetch the public URL from inside the server container (hairpin NAT or DNS can cause this). Verify from outside with: curl <public URL>/.well-known/oauth-authorization-server',
            });
          }
        }
        void reply.send({
          checks,
          checkedAt: services.clock.now().toISOString(),
        } satisfies McpDiscoveryCheckResponse);
      });

      control.get('/connections', async (request, reply) => {
        const query = parseWith(McpConnectionListQuerySchema, request.query);
        void reply.send({ connections: services.connections.list(query) });
      });

      control.post('/connections', async (request, reply) => {
        const body = parseWith(McpControlCreateConnectionRequestSchema, request.body);
        const created = await services.connections.create(body);
        void reply.status(201).header('cache-control', 'no-store').send(created);
      });

      control.get('/connections/:id', async (request, reply) => {
        const { id } = parseWith(IdParams, request.params);
        void reply.send({ connection: services.connections.get(id) });
      });

      control.patch('/connections/:id', async (request, reply) => {
        const { id } = parseWith(IdParams, request.params);
        const body = parseWith(McpControlUpdateConnectionRequestSchema, request.body);
        void reply.send({ connection: services.connections.update(id, body) });
      });

      control.post('/connections/:id/credentials', async (request, reply) => {
        const { id } = parseWith(IdParams, request.params);
        const body = parseWith(McpControlUpdateCredentialsRequestSchema, request.body);
        const connection = await services.connections.updateCredentials(
          id,
          body.mailboxPassword,
          body.mailboxFingerprint,
          body.actor,
        );
        void reply.send({ connection });
      });

      control.post('/connections/:id/reissue', async (request, reply) => {
        const { id } = parseWith(IdParams, request.params);
        const body = parseWith(McpControlActorRequestSchema, request.body);
        void reply
          .header('cache-control', 'no-store')
          .send(await services.connections.reissue(id, body.actor));
      });

      control.post('/connections/:id/rotate', async (request, reply) => {
        const { id } = parseWith(IdParams, request.params);
        const body = parseWith(McpControlActorRequestSchema, request.body);
        void reply
          .header('cache-control', 'no-store')
          .send(await services.connections.rotate(id, body.actor));
      });

      control.post('/connections/:id/test', async (request, reply) => {
        const { id } = parseWith(IdParams, request.params);
        const body = parseWith(McpControlActorRequestSchema, request.body);
        void reply.send(await services.connections.test(id, body.actor));
      });

      control.post('/connections/:id/disable', async (request, reply) => {
        const { id } = parseWith(IdParams, request.params);
        const body = parseWith(McpControlActorRequestSchema, request.body);
        void reply.send({ connection: services.connections.disable(id, body.actor, body.reason) });
      });

      control.post('/connections/:id/enable', async (request, reply) => {
        const { id } = parseWith(IdParams, request.params);
        const body = parseWith(McpControlActorRequestSchema, request.body);
        void reply.send({ connection: services.connections.enable(id, body.actor) });
      });

      control.post('/connections/:id/revoke', async (request, reply) => {
        const { id } = parseWith(IdParams, request.params);
        const body = parseWith(McpControlActorRequestSchema, request.body);
        void reply.send({ connection: services.connections.revoke(id, body.actor, body.reason) });
      });

      control.post('/connections/:id/delete', async (request, reply) => {
        const { id } = parseWith(IdParams, request.params);
        const body = parseWith(McpControlActorRequestSchema, request.body);
        services.connections.delete(id, body.actor);
        void reply.status(204).send();
      });

      control.post('/connections/:id/grants/:grantId/revoke', async (request, reply) => {
        const { id, grantId } = parseWith(GrantParams, request.params);
        const body = parseWith(McpControlActorRequestSchema, request.body);
        void reply.send({ connection: services.connections.revokeGrant(id, grantId, body.actor) });
      });

      control.get('/connections/:id/audit', async (request, reply) => {
        const { id } = parseWith(IdParams, request.params);
        services.connections.get(id); // 404 for unknown ids
        void reply.send({ events: services.audit.list({ connectionId: id, limit: 200 }) });
      });

      control.get('/audit', async (_request, reply) => {
        void reply.send({ events: services.audit.list({ limit: 200 }) });
      });

      control.get('/mailboxes/:mailbox', async (request, reply) => {
        const mailbox = parseWith(
          McpMailboxAddressSchema,
          (request.params as { mailbox?: unknown }).mailbox,
        );
        void reply.send(services.connections.mailboxOverview(mailbox));
      });

      control.post('/mailboxes/reconcile', async (request, reply) => {
        const body = parseWith(McpControlReconcileRequestSchema, request.body);
        void reply.send(services.connections.reconcile(body.mailboxes));
      });

      control.post('/mailboxes/events', async (request, reply) => {
        const body = parseWith(McpControlMailboxEventRequestSchema, request.body);
        void reply.send({
          affectedConnections: services.connections.mailboxEvent(
            body.mailbox,
            body.event,
            body.actor,
          ),
        });
      });
    },
    { prefix: '/control/v1' },
  );

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'No such control route.',
        errorId: 'e_none',
        details: null,
      },
    });
  });

  return app;
}
