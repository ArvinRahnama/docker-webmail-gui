/**
 * HTTP-layer authentication and authorization guards (M3 —
 * ARCHITECTURE.md §7.2 "route (HTTP, validation, authz)"; SECURITY.md
 * §3.5, §3.6, §3.9).
 *
 * Three composable Fastify `preHandler` hooks, built once per app from a
 * single {@link AuthService} instance via {@link createAuthMiddleware}:
 *
 * - {@link requireSession} resolves the session cookie to a live session
 *   and administrator, attaching both to the request as `request.auth`.
 * - {@link requireCsrf} (state-changing methods only) validates same-
 *   origin evidence and the per-session synchroniser token.
 * - {@link requirePermission} enforces server-side authorization from the
 *   role -> permission map in `roles.ts` — never from anything the client
 *   sent (SECURITY.md §3.9: "authorization is enforced server-side per
 *   route — never inferred from the UI").
 *
 * `requireCsrf` and `requirePermission` both read `request.auth`, so a
 * route's `preHandler` array must always list `requireSession` first.
 * Both fail closed (throw `UNAUTHENTICATED`) if it was omitted rather than
 * trusting that it ran.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { CSRF_HEADER_NAME } from '@dwg/shared';
import { AppError } from '../../platform/errors.js';
import type { AppConfig } from '../../platform/config.js';
import type { AdminRow } from './admins.repository.js';
import type { SessionRow } from './sessions.repository.js';
import type { AuthService } from './auth.service.js';
import { timingSafeEqualString } from './tokens.js';
import { roleHasPermission, type Permission } from './roles.js';

/** Name of the cookie carrying the opaque session token (ARCHITECTURE.md §7.4). */
export const SESSION_COOKIE_NAME = 'dwg_session';

/** What {@link requireSession} attaches to an authenticated request. */
export interface AuthContext {
  readonly session: SessionRow;
  readonly admin: AdminRow;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by {@link requireSession}; `null` until then. Read it via {@link requireAuthContext}, not directly, in route handlers. */
    auth: AuthContext | null;
  }
}

const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Clears the session cookie with the same `path` it was set with — a
 * mismatched attribute leaves the browser holding a cookie it thinks is
 * still there. Exported so `auth.routes.ts`'s logout handler and
 * `requireSession`'s invalid-session path both clear it identically.
 */
export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

/**
 * Reads `request.auth`, populated by {@link requireSession}. Throws
 * rather than returning `null` so route handlers get a non-nullable value
 * without a manual assertion — and so a route that was mis-wired without
 * `requireSession` in its `preHandler` chain fails closed with a normal
 * `UNAUTHENTICATED` response instead of a raw `TypeError`.
 */
export function requireAuthContext(request: FastifyRequest): AuthContext {
  if (request.auth === null) {
    throw new AppError('UNAUTHENTICATED', 'Authentication is required.');
  }
  return request.auth;
}

export interface RequireSessionOptions {
  /**
   * Lets an admin whose `forcePasswordChange` flag is set reach this
   * route anyway. Only `POST /auth/logout`, `POST /auth/change-password`
   * and `GET /auth/csrf-token` set this: the first two are how the
   * requirement gets satisfied or abandoned, and the third is a
   * prerequisite for submitting the change-password request itself
   * (`requireCsrf` needs a token to check against) — leaving it gated
   * would strand a force-password-change admin with no way to ever
   * satisfy the requirement.
   */
  readonly allowPasswordChangeRequired?: boolean;
}

export type RequireSession = (options?: RequireSessionOptions) => preHandlerHookHandler;
export type RequireCsrf = () => preHandlerHookHandler;
export type RequirePermission = (permission: Permission) => preHandlerHookHandler;

export interface AuthMiddleware {
  readonly requireSession: RequireSession;
  readonly requireCsrf: RequireCsrf;
  readonly requirePermission: RequirePermission;
}

export interface AuthMiddlewareDeps {
  readonly authService: AuthService;
  readonly config: AppConfig;
}

/**
 * Same-origin evidence for a state-changing request (SECURITY.md §3.6).
 * `Sec-Fetch-Site`, sent by every modern browser on a `fetch`/`XHR`
 * request, is authoritative when present. A client that omits it still
 * sends `Origin` on every unsafe-method request per the Fetch standard,
 * so that is the fallback. A request carrying neither fails closed — a
 * same-origin request from a real browser always sends at least one, and
 * CORS is not enabled (ARCHITECTURE.md §7.2), so there is no legitimate
 * cross-origin caller this could false-positive against.
 */
function isSameOriginRequest(request: FastifyRequest): boolean {
  const secFetchSite = request.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string') {
    return secFetchSite === 'same-origin';
  }

  const origin = request.headers.origin;
  const hostHeader = request.headers.host;
  if (typeof origin !== 'string' || typeof hostHeader !== 'string') {
    return false;
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  // `URL#host` (per the WHATWG URL spec) silently drops a port that
  // matches the scheme's default — `new URL('http://x:80').host` is
  // `'x'`, not `'x:80'`. The raw `Host` header gets no such
  // normalisation, so a client that spells out the default port there
  // (light-my-request's injected requests do exactly this) would
  // otherwise fail a byte-for-byte comparison despite being genuinely
  // same-origin. Accepting either form — the header as sent, or with a
  // trailing :80/:443 stripped — covers both without needing to know
  // which scheme the request actually arrived over.
  const hostWithoutDefaultPort = hostHeader.replace(/:(?:80|443)$/, '');
  return (
    originHost.toLowerCase() === hostHeader.toLowerCase() ||
    originHost.toLowerCase() === hostWithoutDefaultPort.toLowerCase()
  );
}

/**
 * Builds the three guards above, bound to one app's `AuthService`.
 * Decorates `request.auth` on `app` so every request carries the slot
 * `requireSession` will fill in.
 */
export function createAuthMiddleware(
  app: FastifyInstance,
  deps: AuthMiddlewareDeps,
): AuthMiddleware {
  const { authService } = deps;
  app.decorateRequest('auth', null);

  const requireSession: RequireSession = (options = {}) => {
    return async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE_NAME];
      if (token === undefined) {
        throw new AppError('UNAUTHENTICATED', 'Authentication is required.');
      }

      const result = authService.validateSession(token);
      if (!result.valid) {
        // A dead cookie (unknown/revoked/expired/idle/admin-unusable) must
        // not linger in the browser once we know it authenticates nothing
        // — otherwise every subsequent request keeps paying the lookup
        // just to fail again, and the client has no signal to stop
        // sending it.
        clearSessionCookie(reply);
        throw new AppError('UNAUTHENTICATED', 'Authentication is required.');
      }

      request.auth = { session: result.session, admin: result.admin };

      if (result.admin.forcePasswordChange && options.allowPasswordChangeRequired !== true) {
        throw new AppError(
          'PASSWORD_CHANGE_REQUIRED',
          'You must change your password before continuing.',
        );
      }
    };
  };

  const requireCsrf: RequireCsrf = () => {
    return async (request) => {
      if (!STATE_CHANGING_METHODS.has(request.method)) {
        return;
      }

      const auth = requireAuthContext(request);

      // Checked before the token itself: a cross-site caller that somehow
      // guessed or replayed a token still gets the same generic rejection,
      // not a different one that would confirm the token was close.
      if (!isSameOriginRequest(request)) {
        throw new AppError('FORBIDDEN', 'Cross-site request rejected.');
      }

      const header = request.headers[CSRF_HEADER_NAME];
      if (typeof header !== 'string' || header.length === 0) {
        throw new AppError('FORBIDDEN', 'Missing CSRF token.');
      }

      if (!timingSafeEqualString(header, auth.session.csrfToken)) {
        throw new AppError('FORBIDDEN', 'Invalid CSRF token.');
      }
    };
  };

  const requirePermission: RequirePermission = (permission) => {
    return async (request) => {
      const auth = requireAuthContext(request);
      if (!roleHasPermission(auth.admin.role, permission)) {
        throw new AppError('FORBIDDEN', 'You are not permitted to perform this action.');
      }
    };
  };

  return { requireSession, requireCsrf, requirePermission };
}
