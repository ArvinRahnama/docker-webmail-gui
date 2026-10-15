/**
 * Public OAuth + discovery routes. All protocol logic lives in the services
 * (oauth/*.service.ts); this file is HTTP shape only.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { OAuthError, sendOAuthError } from '../platform/errors.js';
import type { SettingsRepository } from '../store/settings.repository.js';
import type { ConnectionsRepository } from '../store/connections.repository.js';
import type { AuthorizationService, AuthorizeOutcome } from '../oauth/authorization.service.js';
import type { ClientsService } from '../oauth/clients.service.js';
import type { TokensService } from '../oauth/tokens.service.js';
import {
  AUTHORIZE_STYLESHEET,
  renderConsentPage,
  renderErrorPage,
  renderLoginPage,
} from '../web/authorize-views.js';
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  CONNECTION_ID_PATTERN,
} from '../oauth/endpoints.js';
import { DuplicateParameterError } from './form-body.js';

export interface OAuthRoutesDeps {
  readonly settings: SettingsRepository;
  readonly connectionsRepo: ConnectionsRepository;
  readonly authorization: AuthorizationService;
  readonly clients: ClientsService;
  readonly tokens: TokensService;
  readonly requireHttps: boolean;
}

/** Name of the authorization-transaction cookie — distinct from the admin panel's `dwg_session`, on another origin entirely. */
export function transactionCookieName(secure: boolean): string {
  // The __Host- prefix pins the cookie to this exact origin (Secure, Path=/, no Domain).
  return secure ? '__Host-dwg_mcp_authz' : 'dwg_mcp_authz';
}

const PAGE_CSP_BASE =
  "default-src 'none'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'";

function sendPage(
  reply: FastifyReply,
  status: number,
  html: string,
  formActionExtra: string | null,
): void {
  void reply
    .status(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('pragma', 'no-cache')
    .header('x-frame-options', 'DENY')
    .header(
      'content-security-policy',
      // Chrome applies form-action to the redirect that follows a form POST,
      // so the consent page must allow exactly the validated redirect origin.
      `${PAGE_CSP_BASE}; form-action 'self'${formActionExtra !== null ? ` ${formActionExtra}` : ''}`,
    )
    .send(html);
}

function isSameOriginPost(request: FastifyRequest): boolean {
  const site = request.headers['sec-fetch-site'];
  if (typeof site === 'string') return site === 'same-origin';
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function formOf(request: FastifyRequest): Record<string, string> {
  const body = request.body;
  if (body === null || typeof body !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export async function registerOAuthRoutes(
  app: FastifyInstance,
  deps: OAuthRoutesDeps,
): Promise<void> {
  const secureCookie = (): boolean =>
    (deps.settings.get().publicBaseUrl ?? '').startsWith('https://');

  const renderOutcome = (reply: FastifyReply, outcome: AuthorizeOutcome): void => {
    switch (outcome.kind) {
      case 'error_page':
        sendPage(reply, outcome.status, renderErrorPage(outcome.title, outcome.message), null);
        return;
      case 'redirect':
        void reply.header('cache-control', 'no-store').redirect(outcome.url, 303);
        return;
      case 'login':
        if (outcome.setCookie) {
          const secure = secureCookie();
          void reply.setCookie(transactionCookieName(secure), outcome.txn, {
            path: '/',
            httpOnly: true,
            secure,
            sameSite: 'strict',
            maxAge: 600,
          });
        }
        sendPage(
          reply,
          outcome.error === null ? 200 : 400,
          renderLoginPage({
            txn: outcome.txn,
            csrf: outcome.csrf,
            client: outcome.client,
            maskedMailbox: outcome.maskedMailbox,
            scopes: outcome.scopes,
            expiresAt: outcome.expiresAt,
            error: outcome.error,
            username: outcome.username,
          }),
          null,
        );
        return;
      case 'consent':
        sendPage(
          reply,
          200,
          renderConsentPage({
            txn: outcome.txn,
            csrf: outcome.csrf,
            client: outcome.client,
            mailbox: outcome.mailbox,
            scopes: outcome.scopes,
          }),
          outcome.redirectOrigin,
        );
        return;
    }
  };

  // -- Discovery --------------------------------------------------------------

  app.get('/.well-known/oauth-authorization-server', async (_request, reply) => {
    const settings = deps.settings.get();
    const metadata = settings.enabled ? buildAuthorizationServerMetadata(settings) : null;
    if (metadata === null) {
      void reply
        .status(404)
        .send({ error: 'not_found', error_description: 'MCP is not enabled on this server.' });
      return;
    }
    void reply.header('cache-control', 'public, max-age=300').send(metadata);
  });

  // Only RFC 8414 discovery is offered: this server issues no ID tokens, so
  // advertising OpenID Connect Discovery would be a false claim.
  app.get('/.well-known/openid-configuration', async (_request, reply) => {
    void reply
      .status(404)
      .send({ error: 'not_found', error_description: 'OpenID Connect is not offered.' });
  });

  app.get('/.well-known/oauth-protected-resource', async (_request, reply) => {
    void reply.status(404).send({
      error: 'not_found',
      error_description: 'Each MCP connection has its own resource metadata.',
    });
  });

  app.get<{ Params: { id: string } }>(
    '/.well-known/oauth-protected-resource/mcp/:id',
    async (request, reply) => {
      const settings = deps.settings.get();
      const connection = CONNECTION_ID_PATTERN.test(request.params.id)
        ? deps.connectionsRepo.findById(request.params.id)
        : undefined;
      const document =
        settings.enabled && connection !== undefined && connection.state !== 'revoked'
          ? buildProtectedResourceMetadata(settings, connection.id, connection.scopes)
          : null;
      if (document === null) {
        void reply
          .status(404)
          .send({ error: 'not_found', error_description: 'Unknown MCP resource.' });
        return;
      }
      void reply.header('cache-control', 'no-store').send(document);
    },
  );

  app.get('/oauth/assets/authorize.css', async (_request, reply) => {
    void reply
      .header('content-type', 'text/css; charset=utf-8')
      .header('cache-control', 'public, max-age=3600')
      .send(AUTHORIZE_STYLESHEET);
  });

  // -- Browser authorization flow (rate limited per IP) -----------------------

  await app.register(async (scope) => {
    await scope.register(fastifyRateLimit, {
      max: 60,
      timeWindow: '1 minute',
      errorResponseBuilder: () => ({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Too many requests.',
      }),
    });

    scope.get('/oauth/authorize', async (request, reply) => {
      const outcome = await deps.authorization.start(
        request.query as Record<string, unknown>,
        request.ip,
      );
      renderOutcome(reply, outcome);
    });

    scope.post('/oauth/authorize/login', async (request, reply) => {
      if (!isSameOriginPost(request)) {
        sendPage(
          reply,
          403,
          renderErrorPage('Request rejected', 'Cross-site form submission rejected.'),
          null,
        );
        return;
      }
      const cookie = request.cookies[transactionCookieName(secureCookie())];
      renderOutcome(reply, await deps.authorization.login(formOf(request), cookie, request.ip));
    });

    scope.post('/oauth/authorize/decision', async (request, reply) => {
      if (!isSameOriginPost(request)) {
        sendPage(
          reply,
          403,
          renderErrorPage('Request rejected', 'Cross-site form submission rejected.'),
          null,
        );
        return;
      }
      const secure = secureCookie();
      const cookie = request.cookies[transactionCookieName(secure)];
      const outcome = await deps.authorization.decide(formOf(request), cookie, request.ip);
      if (outcome.kind === 'redirect') {
        void reply.clearCookie(transactionCookieName(secure), {
          path: '/',
          secure,
          httpOnly: true,
          sameSite: 'strict',
        });
      }
      renderOutcome(reply, outcome);
    });
  });

  // -- Back-channel endpoints (JSON errors, CORS, no cookies) -----------------

  await app.register(async (scope) => {
    await scope.register(fastifyRateLimit, {
      max: 120,
      timeWindow: '1 minute',
      errorResponseBuilder: () =>
        new OAuthError('temporarily_unavailable', 'Too many requests.', 429),
    });

    scope.setErrorHandler((err, _request, reply) => {
      if (err instanceof OAuthError) return sendOAuthError(reply, err);
      if (err instanceof DuplicateParameterError) {
        return sendOAuthError(reply, new OAuthError('invalid_request', err.message));
      }
      const status =
        typeof (err as { statusCode?: unknown }).statusCode === 'number'
          ? (err as { statusCode: number }).statusCode
          : 500;
      if (status === 429)
        return sendOAuthError(
          reply,
          new OAuthError('temporarily_unavailable', 'Too many requests.', 429),
        );
      if (status >= 400 && status < 500) {
        return sendOAuthError(
          reply,
          new OAuthError(
            'invalid_request',
            'The request could not be parsed.',
            status === 413 ? 413 : 400,
          ),
        );
      }
      reply.log.error({ err }, 'oauth endpoint error');
      return sendOAuthError(reply, new OAuthError('server_error', 'Internal error.', 500));
    });

    const requireEnabled = (): void => {
      const settings = deps.settings.get();
      if (!settings.enabled || settings.publicBaseUrl === null) {
        throw new OAuthError('temporarily_unavailable', 'MCP is not enabled on this server.', 503);
      }
      if (deps.requireHttps && !settings.publicBaseUrl.startsWith('https://')) {
        throw new OAuthError('temporarily_unavailable', 'The MCP public URL must be https.', 503);
      }
    };

    scope.post('/oauth/register', async (request, reply) => {
      requireEnabled();
      const body = deps.clients.register(request.body, request.ip);
      void reply.status(201).header('cache-control', 'no-store').send(body);
    });

    scope.post('/oauth/token', async (request, reply) => {
      requireEnabled();
      const form = formOf(request);
      if (
        !String(request.headers['content-type'] ?? '').startsWith(
          'application/x-www-form-urlencoded',
        )
      ) {
        throw new OAuthError(
          'invalid_request',
          'The token endpoint accepts application/x-www-form-urlencoded only.',
        );
      }
      const client = await deps.clients.authenticate({
        authorizationHeader: request.headers.authorization,
        bodyClientId: form['client_id'],
        bodyClientSecret: form['client_secret'],
        ip: request.ip,
      });
      let response;
      switch (form['grant_type']) {
        case 'authorization_code':
          response = await deps.tokens.exchangeCode({
            client,
            code: form['code'],
            redirectUri: form['redirect_uri'],
            codeVerifier: form['code_verifier'],
            resource: form['resource'],
            ip: request.ip,
          });
          break;
        case 'refresh_token':
          if (!client.grantTypes.includes('refresh_token')) {
            throw new OAuthError('unauthorized_client', 'This client may not use refresh tokens.');
          }
          response = await deps.tokens.refresh({
            client,
            refreshToken: form['refresh_token'],
            scope: form['scope'],
            resource: form['resource'],
            ip: request.ip,
          });
          break;
        default:
          throw new OAuthError(
            'unsupported_grant_type',
            'Only authorization_code and refresh_token are supported.',
          );
      }
      void reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send(response);
    });

    scope.post('/oauth/revoke', async (request, reply) => {
      requireEnabled();
      const form = formOf(request);
      const client = await deps.clients.authenticate({
        authorizationHeader: request.headers.authorization,
        bodyClientId: form['client_id'],
        bodyClientSecret: form['client_secret'],
        ip: request.ip,
      });
      if (form['token'] === undefined)
        throw new OAuthError('invalid_request', 'token is required.');
      deps.tokens.revoke({
        client,
        token: form['token'],
        hint: form['token_type_hint'],
        ip: request.ip,
      });
      void reply.status(200).header('cache-control', 'no-store').send({});
    });
  });
}
