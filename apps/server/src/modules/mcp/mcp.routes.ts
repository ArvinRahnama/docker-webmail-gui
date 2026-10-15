/**
 * `/api/v1/mcp/*` — postmaster-only MCP management (docs/mcp-integration.md).
 *
 * Every route: admin session → CSRF (mutations) → `mcp:manage` permission,
 * in that order, server-side. Mutations are rate limited and audited in the
 * admin audit log. Responses that carry a one-time setup password
 * (create/reissue/rotate) are `no-store`, and there is no route that can
 * return one again. The mailbox IMAP/SMTP password is accepted in request
 * bodies only and forwarded once to apps/mcp's vault; it is never stored
 * here, never logged (logger redaction covers `mailboxPassword`), and never
 * echoed back.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import {
  CreateMcpConnectionRequestSchema,
  CreateMcpConnectionResponseSchema,
  McpAuditListResponseSchema,
  McpConnectionDetailResponseSchema,
  McpConnectionIdSchema,
  McpConnectionListQuerySchema,
  McpConnectionListResponseSchema,
  McpConnectionTestResponseSchema,
  McpCredentialIssueResponseSchema,
  McpDiscoveryCheckResponseSchema,
  McpMailboxAddressSchema,
  McpMailboxOverviewResponseSchema,
  McpRevokeRequestSchema,
  McpSettingsPatchSchema,
  McpSettingsResponseSchema,
  McpStatusResponseSchema,
  UpdateMcpConnectionRequestSchema,
  UpdateMcpCredentialsRequestSchema,
} from '@dwg/shared';
import { AppError } from '../../platform/errors.js';
import { recordAuditEvent, type AuditAction, type AuditDetails } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import { parseBody } from '../auth/auth.routes.js';
import type { McpControlClient } from '../../drivers/mcp-control/index.js';
import type { McpService } from './mcp.service.js';

export interface McpRoutesDeps {
  readonly db: Database;
  readonly mcpService: McpService;
  readonly control: McpControlClient;
  readonly middleware: AuthMiddleware;
}

const IdParamsSchema = z.object({ id: McpConnectionIdSchema });
const GrantParamsSchema = z.object({
  id: McpConnectionIdSchema,
  grantId: z.string().regex(/^gr_[0-9a-z]{26}$/),
});
const MailboxParamsSchema = z.object({ address: McpMailboxAddressSchema });

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const result = schema.safeParse(params);
  if (!result.success) throw new AppError('NOT_FOUND', 'No such MCP connection.');
  return result.data;
}

function parseQuery<T>(schema: z.ZodType<T>, query: unknown): T {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', 'The request query parameters failed validation.', {
      details: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export async function registerMcpRoutes(app: FastifyInstance, deps: McpRoutesDeps): Promise<void> {
  const { db, mcpService, control, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  const audit = (
    request: FastifyRequest,
    action: AuditAction,
    target: { type: string; id: string } | null,
    details: AuditDetails,
  ) => {
    const auth = requireAuthContext(request);
    recordAuditEvent(db, {
      actor: { adminId: auth.admin.id, label: auth.admin.email },
      action,
      target,
      result: 'success',
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      details,
    });
  };
  const actorOf = (request: FastifyRequest) => requireAuthContext(request).admin.email;
  const noStore = (reply: FastifyReply) =>
    reply.header('cache-control', 'no-store').header('pragma', 'no-cache');

  await app.register(
    async (mcpApp) => {
      mcpApp.addHook('preHandler', requireSession());
      mcpApp.addHook('preHandler', requireCsrf());
      mcpApp.addHook('preHandler', requirePermission('mcp:manage'));

      await mcpApp.register(fastifyRateLimit, {
        max: 120,
        timeWindow: '1 minute',
        errorResponseBuilder: () =>
          new AppError('RATE_LIMITED', 'Too many MCP management requests. Try again shortly.'),
      });

      // -- Service ------------------------------------------------------------

      mcpApp.get('/status', async (_request, reply) => {
        void reply.send(McpStatusResponseSchema.parse(await mcpService.status()));
      });

      mcpApp.get('/settings', async (_request, reply) => {
        void reply.send(McpSettingsResponseSchema.parse(await control.getSettings()));
      });

      mcpApp.patch('/settings', async (request, reply) => {
        const patch = parseBody(McpSettingsPatchSchema, request.body);
        const result = await control.patchSettings(actorOf(request), patch);
        audit(request, 'mcp.settings_update', null, {
          fields: Object.keys(patch).sort().join(','),
          enabled: patch.enabled ?? null,
        });
        void reply.send(McpSettingsResponseSchema.parse(result));
      });

      mcpApp.post('/discovery-check', async (request, reply) => {
        const result = await control.discoveryCheck();
        audit(request, 'mcp.discovery_check', null, { passed: result.checks.every((c) => c.ok) });
        void reply.send(McpDiscoveryCheckResponseSchema.parse(result));
      });

      mcpApp.get('/audit', async (_request, reply) => {
        void reply.send(McpAuditListResponseSchema.parse(await control.audit()));
      });

      mcpApp.get('/mailboxes/:address', async (request, reply) => {
        const { address } = parseParams(MailboxParamsSchema, request.params);
        void reply.send(
          McpMailboxOverviewResponseSchema.parse(await control.mailboxOverview(address)),
        );
      });

      // -- Connections --------------------------------------------------------

      mcpApp.get('/connections', async (request, reply) => {
        const query = parseQuery(McpConnectionListQuerySchema, request.query);
        void reply.send(
          McpConnectionListResponseSchema.parse(await control.listConnections(query)),
        );
      });

      mcpApp.post('/connections', async (request, reply) => {
        const body = parseBody(CreateMcpConnectionRequestSchema, request.body);
        const result = await mcpService.create(actorOf(request), body);
        audit(
          request,
          'mcp.connection_create',
          { type: 'mcp_connection', id: result.connection.id },
          {
            mailbox: result.connection.mailbox,
            permissions: result.connection.permissions.join(' '),
            provisioned: body.mailboxPassword !== undefined,
          },
        );
        noStore(reply).status(201);
        void reply.send(CreateMcpConnectionResponseSchema.parse(result));
      });

      mcpApp.get('/connections/:id', async (request, reply) => {
        const { id } = parseParams(IdParamsSchema, request.params);
        void reply.send(McpConnectionDetailResponseSchema.parse(await control.getConnection(id)));
      });

      mcpApp.patch('/connections/:id', async (request, reply) => {
        const { id } = parseParams(IdParamsSchema, request.params);
        const body = parseBody(UpdateMcpConnectionRequestSchema, request.body);
        const result = await mcpService.update(actorOf(request), id, body);
        audit(
          request,
          'mcp.connection_update',
          { type: 'mcp_connection', id },
          {
            mailbox: result.connection.mailbox,
            permissions: body.permissions?.join(' ') ?? null,
            labelChanged: body.label !== undefined,
            senderIdentityCount: body.senderIdentities?.length ?? null,
          },
        );
        void reply.send(McpConnectionDetailResponseSchema.parse(result));
      });

      mcpApp.post('/connections/:id/credentials', async (request, reply) => {
        const { id } = parseParams(IdParamsSchema, request.params);
        const body = parseBody(UpdateMcpCredentialsRequestSchema, request.body);
        const result = await mcpService.updateCredentials(
          actorOf(request),
          id,
          body.mailboxPassword,
        );
        audit(
          request,
          'mcp.connection_provision',
          { type: 'mcp_connection', id },
          { mailbox: result.connection.mailbox },
        );
        void reply.send(McpConnectionDetailResponseSchema.parse(result));
      });

      const issueRoute = (path: 'reissue' | 'rotate', action: AuditAction) =>
        mcpApp.post(`/connections/:id/${path}`, async (request, reply) => {
          const { id } = parseParams(IdParamsSchema, request.params);
          const actor = { actor: actorOf(request) };
          const result =
            path === 'reissue' ? await control.reissue(id, actor) : await control.rotate(id, actor);
          audit(
            request,
            action,
            { type: 'mcp_connection', id },
            { mailbox: result.connection.mailbox },
          );
          noStore(reply);
          void reply.send(McpCredentialIssueResponseSchema.parse(result));
        });
      issueRoute('reissue', 'mcp.connection_reissue');
      issueRoute('rotate', 'mcp.connection_rotate');

      mcpApp.post('/connections/:id/test', async (request, reply) => {
        const { id } = parseParams(IdParamsSchema, request.params);
        const result = await control.test(id, { actor: actorOf(request) });
        audit(
          request,
          'mcp.connection_test',
          { type: 'mcp_connection', id },
          {
            imapOk: result.result.imap.ok,
            smtpOk: result.result.smtp.ok,
          },
        );
        void reply.send(McpConnectionTestResponseSchema.parse(result));
      });

      const stateRoute = (path: 'disable' | 'enable' | 'revoke', action: AuditAction) =>
        mcpApp.post(`/connections/:id/${path}`, async (request, reply) => {
          const { id } = parseParams(IdParamsSchema, request.params);
          const body = parseBody(McpRevokeRequestSchema, request.body ?? {});
          const actor = {
            actor: actorOf(request),
            ...(body.reason !== undefined ? { reason: body.reason } : {}),
          };
          const result =
            path === 'disable'
              ? await control.disable(id, actor)
              : path === 'enable'
                ? await control.enable(id, actor)
                : await control.revoke(id, actor);
          audit(
            request,
            action,
            { type: 'mcp_connection', id },
            { mailbox: result.connection.mailbox },
          );
          void reply.send(McpConnectionDetailResponseSchema.parse(result));
        });
      stateRoute('disable', 'mcp.connection_disable');
      stateRoute('enable', 'mcp.connection_enable');
      stateRoute('revoke', 'mcp.connection_revoke');

      mcpApp.delete('/connections/:id', async (request, reply) => {
        const { id } = parseParams(IdParamsSchema, request.params);
        const { connection } = await control.getConnection(id);
        await control.deleteConnection(id, { actor: actorOf(request) });
        audit(
          request,
          'mcp.connection_delete',
          { type: 'mcp_connection', id },
          { mailbox: connection.mailbox },
        );
        reply.status(204);
        void reply.send();
      });

      mcpApp.delete('/connections/:id/grants/:grantId', async (request, reply) => {
        const { id, grantId } = parseParams(GrantParamsSchema, request.params);
        const result = await control.revokeGrant(id, grantId, { actor: actorOf(request) });
        audit(
          request,
          'mcp.grant_revoke',
          { type: 'mcp_connection', id },
          { grantId, mailbox: result.connection.mailbox },
        );
        void reply.send(McpConnectionDetailResponseSchema.parse(result));
      });

      mcpApp.get('/connections/:id/audit', async (request, reply) => {
        const { id } = parseParams(IdParamsSchema, request.params);
        void reply.send(McpAuditListResponseSchema.parse(await control.connectionAudit(id)));
      });
    },
    { prefix: '/api/v1/mcp' },
  );
}
