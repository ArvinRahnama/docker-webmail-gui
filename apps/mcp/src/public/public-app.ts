/**
 * The internet-facing listener (behind the operator's TLS reverse proxy):
 * discovery, the OAuth authorization server, the hosted authorization page,
 * and the per-connection MCP endpoints. Nothing here can manage connections
 * — that is the control API's job, which is never bound to a socket and is
 * reached only in-process by the panel.
 */
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import type { Services } from '../services.js';
import { registerFormBodyParser } from './form-body.js';
import { registerOAuthRoutes } from './oauth.routes.js';
import { registerMcpRoutes } from './mcp.routes.js';

const CORS_PATH = /^\/(?:\.well-known\/|oauth\/(?:token|register|revoke)$|mcp\/)/;

export async function buildPublicApp(services: Services, logger: Logger): Promise<FastifyInstance> {
  const app = Fastify<Server, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: logger,
    trustProxy: services.config.trustProxy,
    bodyLimit: 1024 * 1024,
  });
  registerFormBodyParser(app);
  await app.register(fastifyCookie);

  // Baseline headers on every public response.
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    if (services.config.requireHttps) {
      reply.header('strict-transport-security', 'max-age=15552000; includeSubDomains');
    }
    // Bearer-token endpoints carry no ambient credentials (no cookies), so a
    // wildcard origin without credentials is safe and lets browser-based MCP
    // clients work. The cookie-bound authorization page is never CORS-enabled.
    const path = request.url.split('?')[0] ?? '';
    if (CORS_PATH.test(path)) {
      reply.header('access-control-allow-origin', '*');
      reply.header(
        'access-control-expose-headers',
        'www-authenticate, mcp-session-id, mcp-protocol-version',
      );
    }
    return payload;
  });

  app.options('/*', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (!CORS_PATH.test(path)) {
      void reply.status(404).send();
      return;
    }
    void reply
      .status(204)
      .header('access-control-allow-origin', '*')
      .header('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
      .header(
        'access-control-allow-headers',
        'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id, mcp-method, mcp-name',
      )
      .header('access-control-max-age', '600')
      .send();
  });

  // HTTPS enforcement (behind a proxy, via X-Forwarded-Proto from a trusted hop).
  app.addHook('onRequest', async (request, reply) => {
    if (!services.config.requireHttps || request.url === '/healthz') return;
    if (request.protocol !== 'https') {
      void reply.status(400).header('content-type', 'application/json').send({
        error: 'https_required',
        error_description: 'This endpoint is only available over HTTPS.',
      });
    }
  });

  app.get('/healthz', async (_request, reply) => {
    void reply.header('cache-control', 'no-store').send({ status: 'ok' });
  });

  await registerOAuthRoutes(app, {
    settings: services.settings,
    connectionsRepo: services.connectionsRepo,
    authorization: services.authorization,
    clients: services.clients,
    tokens: services.tokens,
    requireHttps: services.config.requireHttps,
  });

  const mcpHandler = await registerMcpRoutes(app, {
    bearer: services.bearer,
    tools: services.toolDeps,
  });
  app.addHook('onClose', async () => {
    await mcpHandler.close();
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({ error: 'not_found' });
  });

  return app;
}
