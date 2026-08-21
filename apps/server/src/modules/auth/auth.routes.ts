/**
 * `/api/v1/auth/*` routes (M3 — ARCHITECTURE.md §7.1, §7.2).
 *
 * Every handler is a thin HTTP shell around `AuthService`: parse and
 * validate the body with the shared Zod schema, call the service, map its
 * result onto the cookie/response shape SECURITY.md and ARCHITECTURE.md
 * describe. No business logic (lockout, timing, session lifecycle) lives
 * here — that is all `AuthService`'s job, and this module must not
 * duplicate or "help" it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import type { z } from 'zod';
import {
  ChangePasswordRequestSchema,
  ChangePasswordResponseSchema,
  CsrfTokenResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutResponseSchema,
  SessionInfoResponseSchema,
  type ChangePasswordResponse,
  type CsrfTokenResponse,
  type LoginResponse,
  type LogoutResponse,
  type SessionInfoResponse,
} from '@dwg/shared';
import { AppError } from '../../platform/errors.js';
import type { AppConfig } from '../../platform/config.js';
import type { AuthService } from './auth.service.js';
import { toAdminSummary } from './auth.service.js';
import {
  clearSessionCookie,
  requireAuthContext,
  SESSION_COOKIE_NAME,
  type AuthMiddleware,
} from './auth.middleware.js';

export interface AuthRoutesDeps {
  readonly authService: AuthService;
  readonly config: AppConfig;
  readonly middleware: AuthMiddleware;
}

/**
 * Validates `body` against `schema`, or throws the same `VALIDATION_FAILED`
 * `AppError` every other malformed request produces (ARCHITECTURE.md
 * §7.1). Shared with `admins.routes.ts` so request validation looks and
 * behaves identically everywhere under this module.
 */
export function parseBody<Output>(schema: z.ZodType<Output>, body: unknown): Output {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', 'The request body failed validation.', {
      details: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

function userAgentOf(request: FastifyRequest): string | null {
  return request.headers['user-agent'] ?? null;
}

function setSessionCookie(reply: FastifyReply, config: AppConfig, token: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: config.cookieSecure,
    maxAge: Math.round(config.session.absoluteTtlHours * 3_600),
  });
}

// Defence in depth alongside AuthService's own per-identifier/per-IP
// lockout (SECURITY.md §3.5): a coarse request-flood guard in front of
// it. Deliberately looser than LOCKOUT_POLICY — this layer has no notion
// of "identifier" (it runs before the body is even parsed) and must never
// be what locks out a legitimate admin sharing a NAT'd/proxied address.
const LOGIN_RATE_LIMIT_MAX = 20;
const LOGIN_RATE_LIMIT_WINDOW = '1 minute';

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRoutesDeps,
): Promise<void> {
  const { authService, config, middleware } = deps;
  const { requireSession, requireCsrf } = middleware;

  await app.register(
    async (authApp) => {
      // Encapsulated sub-scope: @fastify/rate-limit's hook applies only to
      // routes registered inside it, so this throttles /login alone
      // rather than every route under /api/v1/auth.
      await authApp.register(async (loginScope) => {
        await loginScope.register(fastifyRateLimit, {
          max: LOGIN_RATE_LIMIT_MAX,
          timeWindow: LOGIN_RATE_LIMIT_WINDOW,
          // Keep the uniform ARCHITECTURE.md §7.1 envelope even for a
          // plugin-generated rejection: returning an AppError here means
          // it flows through the same error handler as everything else,
          // rather than the plugin's own default `{statusCode, error,
          // message}` shape.
          errorResponseBuilder: () =>
            new AppError('RATE_LIMITED', 'Too many login attempts. Try again later.'),
        });

        loginScope.post('/login', async (request, reply) => {
          const body = parseBody(LoginRequestSchema, request.body);
          const outcome = await authService.login({
            email: body.email,
            password: body.password,
            ipAddress: request.ip,
            userAgent: userAgentOf(request),
          });

          // Same envelope, same status, regardless of *why* — the service
          // already refuses to say why (LoginFailure carries no reason
          // field at all), so there is nothing here to branch on even by
          // accident.
          if (!outcome.ok) {
            throw new AppError('INVALID_CREDENTIALS', 'Incorrect email or password.');
          }

          setSessionCookie(reply, config, outcome.token);
          const response: LoginResponse = { admin: outcome.admin };
          void reply.send(LoginResponseSchema.parse(response));
        });
      });

      authApp.post(
        '/logout',
        { preHandler: [requireSession({ allowPasswordChangeRequired: true }), requireCsrf()] },
        async (request, reply) => {
          const { session, admin } = requireAuthContext(request);
          authService.logout(session, admin, request.ip, userAgentOf(request));
          clearSessionCookie(reply);
          const response: LogoutResponse = { loggedOut: true };
          void reply.send(LogoutResponseSchema.parse(response));
        },
      );

      // allowPasswordChangeRequired: true — read-only, and reveals nothing
      // beyond what /login's own response already returned (the same
      // AdminSummary, including forcePasswordChange). The SPA's routing
      // (auth-guard.tsx's RequireAuth/RedirectIfAuthenticated) depends on
      // being able to read forcePasswordChange from *this* endpoint right
      // after login to decide whether to land on /change-password or the
      // app shell — gating it would strand every fresh admin (bootstrap or
      // admin-created, both start forced) on the login page with a valid
      // session the SPA has no way to discover. See RequireSessionOptions's
      // doc comment in auth.middleware.ts.
      authApp.get(
        '/session',
        { preHandler: [requireSession({ allowPasswordChangeRequired: true })] },
        async (request, reply) => {
          const { session, admin } = requireAuthContext(request);
          const response: SessionInfoResponse = {
            admin: toAdminSummary(admin),
            expiresAt: session.expiresAt,
          };
          void reply.send(SessionInfoResponseSchema.parse(response));
        },
      );

      authApp.post(
        '/change-password',
        { preHandler: [requireSession({ allowPasswordChangeRequired: true }), requireCsrf()] },
        async (request, reply) => {
          const { session, admin } = requireAuthContext(request);
          const body = parseBody(ChangePasswordRequestSchema, request.body);

          const result = await authService.changePassword(
            admin,
            session,
            body.currentPassword,
            body.newPassword,
            request.ip,
            userAgentOf(request),
          );

          if (!result.ok) {
            throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect.');
          }

          const response: ChangePasswordResponse = { admin: result.admin };
          void reply.send(ChangePasswordResponseSchema.parse(response));
        },
      );

      // Exempted from the forcePasswordChange gate: the SPA needs a CSRF
      // token to submit /change-password in the first place, so blocking
      // this route on the same flag would strand a force-password-change
      // admin with no way to ever satisfy it. See RequireSessionOptions's
      // doc comment in auth.middleware.ts.
      authApp.get(
        '/csrf-token',
        { preHandler: [requireSession({ allowPasswordChangeRequired: true })] },
        async (request, reply) => {
          const { session } = requireAuthContext(request);
          const response: CsrfTokenResponse = { csrfToken: session.csrfToken };
          void reply.send(CsrfTokenResponseSchema.parse(response));
        },
      );
    },
    { prefix: '/api/v1/auth' },
  );
}
