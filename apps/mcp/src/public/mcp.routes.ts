/**
 * `/mcp/:connectionId` — the MCP Streamable HTTP endpoint (one URL per
 * connection). Each request is authorized by {@link BearerVerifier} first;
 * only then is it handed to the MCP SDK's handler with a per-request server
 * built for that one connection (stateless serving: 2026-07-28 per-request
 * envelopes natively, and 2025-era clients via the SDK's stateless legacy
 * fallback).
 */
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { BearerVerifier, McpAuthContext } from '../oauth/bearer.js';
import { buildMcpServer, type ToolDeps } from '../mcp/tools.js';

export const MCP_MAX_BODY_BYTES = 48 * 1024 * 1024;

export interface McpRoutesDeps {
  readonly bearer: BearerVerifier;
  readonly tools: ToolDeps;
}

function toWebRequest(request: FastifyRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else headers.set(name, String(value));
  }
  const init: RequestInit = { method: request.method, headers };
  if (request.method === 'POST' && request.body !== undefined) {
    init.body = JSON.stringify(request.body);
  }
  return new Request(`http://mcp.internal${request.url.split('?')[0] ?? '/'}`, init);
}

async function sendWebResponse(reply: FastifyReply, response: Response): Promise<void> {
  reply.status(response.status);
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== 'content-length') reply.header(name, value);
  });
  if (response.body === null) {
    await reply.send();
    return;
  }
  await reply.send(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
  );
}

export async function registerMcpRoutes(
  app: FastifyInstance,
  deps: McpRoutesDeps,
): Promise<McpHttpHandler> {
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const context = authInfo?.extra?.['dwgContext'] as McpAuthContext | undefined;
      if (context === undefined)
        throw new Error('MCP request reached the handler without an authorization context');
      return buildMcpServer(deps.tools, context);
    },
    { legacy: 'stateless', maxRequestBodySize: MCP_MAX_BODY_BYTES, responseMode: 'auto' },
  );

  const serve = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const outcome = deps.bearer.verify(
      request.params.id,
      request.headers.authorization,
      request.ip,
    );
    if (!outcome.ok) {
      if (outcome.challenge !== null) reply.header('www-authenticate', outcome.challenge);
      void reply
        .status(outcome.status)
        .header('cache-control', 'no-store')
        .send({ jsonrpc: '2.0', error: { code: -32001, message: outcome.description }, id: null });
      return;
    }
    const context = outcome.context;
    const response = await handler.fetch(toWebRequest(request), {
      authInfo: {
        token: 'redacted',
        clientId: context.clientId,
        scopes: [...context.scopes],
        extra: { dwgContext: context },
      },
      ...(request.method === 'POST' ? { parsedBody: request.body } : {}),
    });
    await sendWebResponse(reply, response);
  };

  app.post<{ Params: { id: string } }>('/mcp/:id', { bodyLimit: MCP_MAX_BODY_BYTES }, serve);
  app.get<{ Params: { id: string } }>('/mcp/:id', serve);
  app.delete<{ Params: { id: string } }>('/mcp/:id', serve);
  return handler;
}
