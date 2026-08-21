/**
 * Centralised, typed API client (ARCHITECTURE.md §7.1).
 *
 * Every call goes through {@link request}, which:
 *  - always sends `credentials: 'include'` (the session is an HttpOnly
 *    cookie — SECURITY.md/ARCHITECTURE.md §7.4 — so the browser attaches it
 *    automatically, but that only happens if the request opts in);
 *  - attaches the CSRF header (`CSRF_HEADER_NAME` from `@dwg/shared`) on
 *    every state-changing method, fetching and caching the token from
 *    `GET /api/v1/auth/csrf-token` on first need;
 *  - validates the response body against a caller-supplied Zod schema —
 *    the *same* schema the server validated its own output against
 *    (`@dwg/shared`), so a contract drift between server and client is a
 *    thrown error here, not a silent `undefined.foo` deeper in a
 *    component (ARCHITECTURE.md §3);
 *  - maps a non-2xx response through the §7.1 error envelope into
 *    {@link ApiError}, surfacing `errorId` rather than swallowing it;
 *  - on `UNAUTHENTICATED`, calls the registered "session expired" handler
 *    instead of leaving callers to notice a raw 401 themselves.
 */
import type { z } from 'zod';
import {
  CSRF_HEADER_NAME,
  CsrfTokenResponseSchema,
  ApiErrorEnvelopeSchema,
  type ApiError as ApiErrorShape,
} from '@dwg/shared';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A well-formed `{ error: { code, message, errorId, details } }' envelope the server actually sent — see ARCHITECTURE.md §7.1. */
export class ApiError extends Error {
  readonly code: ApiErrorShape['code'];
  readonly errorId: string;
  readonly details: ApiErrorShape['details'];
  readonly httpStatus: number;

  constructor(body: ApiErrorShape, httpStatus: number) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.errorId = body.errorId;
    this.details = body.details;
    this.httpStatus = httpStatus;
  }
}

/**
 * Everything that isn't a well-formed server error envelope: the network
 * request itself failed, the response wasn't JSON, or the JSON didn't
 * match the schema the caller expected (contract drift). §9's ErrorState
 * pattern wants an error ID on every error shown to an admin, including
 * this one, so a `client_...` id is generated locally — the `client_`
 * prefix (vs. the server's `e_...` — see apps/server/src/platform/errors.ts)
 * makes clear it correlates nothing server-side; there is no log line to
 * find with it.
 */
export class ApiClientError extends Error {
  readonly errorId: string;
  override readonly cause?: unknown;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'ApiClientError';
    this.errorId = generateClientErrorId();
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function generateClientErrorId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2);
  return `client_${Date.now().toString(36)}${random}`;
}

// ---------------------------------------------------------------------------
// Session-expiry hook
// ---------------------------------------------------------------------------

export type UnauthenticatedHandler = () => void;

let unauthenticatedHandler: UnauthenticatedHandler = () => {
  if (typeof window !== 'undefined') {
    window.location.assign('/login');
  }
};

/**
 * Lets the app's session layer install a proper SPA redirect (react-router
 * `navigate('/login')`, preserving where the admin was headed) instead of
 * the hard-reload fallback above. Call once, near the app root.
 */
export function setUnauthenticatedHandler(handler: UnauthenticatedHandler): void {
  unauthenticatedHandler = handler;
}

// ---------------------------------------------------------------------------
// CSRF token cache
// ---------------------------------------------------------------------------

let csrfToken: string | null = null;
let csrfTokenRequest: Promise<string> | null = null;

async function fetchCsrfToken(): Promise<string> {
  const response = await fetch('/api/v1/auth/csrf-token', {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new ApiClientError(`Could not obtain a CSRF token (HTTP ${response.status}).`);
  }
  const json: unknown = await response.json();
  const parsed = CsrfTokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new ApiClientError('CSRF token response did not match the expected shape.', {
      cause: parsed.error,
    });
  }
  return parsed.data.csrfToken;
}

async function getCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  csrfTokenRequest ??= fetchCsrfToken();
  const token = await csrfTokenRequest;
  csrfToken = token;
  csrfTokenRequest = null;
  return token;
}

/** Drops the cached CSRF token so the next state-changing request fetches a fresh one — called after login/logout (the session, and so the token, just changed) and after a FORBIDDEN response that might mean the cached token went stale. */
export function invalidateCsrfToken(): void {
  csrfToken = null;
  csrfTokenRequest = null;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

/**
 * Issues one API request and validates its response against `schema`.
 * `path` is server-relative (e.g. `/api/v1/auth/session`) — there's no
 * separate base-URL configuration because the server serves both the API
 * and the built SPA from one origin in production, and the Vite dev
 * server proxies `/api` to it in development (vite.config.ts), so a
 * relative path is always correct.
 */
export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const isStateChanging = STATE_CHANGING_METHODS.has(method);

  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (isStateChanging) headers[CSRF_HEADER_NAME] = await getCsrfToken();

  // Built with conditional spreads, not `body: x ?? undefined` /
  // `signal: options.signal` — under `exactOptionalPropertyTypes`,
  // `RequestInit`'s `body`/`signal` accept "absent" but not "present and
  // explicitly `undefined`", so the key must be omitted entirely rather
  // than set to `undefined` for a bodyless/signal-less request.
  const init: RequestInit = {
    method,
    credentials: 'include',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (cause) {
    throw new ApiClientError('Could not reach the server. Check your connection and try again.', {
      cause,
    });
  }

  let json: unknown;
  try {
    // A 204/empty body is still valid for some future endpoint; only
    // attempt to parse when there's something to parse.
    const text = await response.text();
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch (cause) {
    throw new ApiClientError('The server returned a response that was not valid JSON.', { cause });
  }

  if (!response.ok) {
    const envelope = ApiErrorEnvelopeSchema.safeParse(json);
    if (!envelope.success) {
      throw new ApiClientError(
        `The server returned an error (HTTP ${response.status}) in an unexpected shape.`,
        { cause: envelope.error },
      );
    }

    if (isStateChanging && envelope.data.error.code === 'FORBIDDEN') {
      invalidateCsrfToken();
    }
    if (envelope.data.error.code === 'UNAUTHENTICATED') {
      unauthenticatedHandler();
    }

    throw new ApiError(envelope.data.error, response.status);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiClientError(
      `The server's response for ${method} ${path} did not match the expected shape.`,
      {
        cause: parsed.error,
      },
    );
  }

  return parsed.data;
}
