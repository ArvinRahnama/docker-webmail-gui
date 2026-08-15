/**
 * The error model: a stable `AppError` for services/routes to throw, an
 * `errorId` generator to correlate a response with its server-side log
 * line, and a Fastify error handler that maps anything thrown to the
 * uniform envelope from ARCHITECTURE.md §7.1 —
 * `{ error: { code, message, errorId, details } }` — and never leaks a
 * stack trace or internal message to the client (SECURITY.md, "never
 * returns a stack trace").
 */
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { type ErrorCode, isErrorCode } from '@dwg/shared';

// ---------------------------------------------------------------------------
// AppError
// ---------------------------------------------------------------------------

const DEFAULT_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 502,
  INTERNAL: 500,
};

export interface AppErrorOptions {
  /** Overrides the code's default HTTP status (see {@link DEFAULT_HTTP_STATUS}). */
  readonly httpStatus?: number;
  /** Non-sensitive, structured detail (e.g. field validation issues). Never a secret — it reaches the client as-is. */
  readonly details?: unknown;
}

/**
 * The error type routes and services throw for any expected failure.
 * Carries everything the error handler needs to build the response
 * envelope: a stable {@link ErrorCode}, an HTTP status, a message that is
 * safe to show an admin, and optional non-sensitive details.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? DEFAULT_HTTP_STATUS[code];
    this.details = options.details ?? null;
    Error.captureStackTrace?.(this, AppError);
  }
}

// ---------------------------------------------------------------------------
// ID generation — a compact, sortable, collision-resistant identifier used
// for both `errorId` and (in app.ts) Fastify request IDs. ULID-shaped
// (48-bit millisecond timestamp + 80 bits of CSPRNG randomness, Crockford
// Base32, so it sorts lexicographically in generation order) but hand-rolled
// against node:crypto only — the milestone brief asks that this not pull in
// a dependency (e.g. the `ulid` package) just for this.
// ---------------------------------------------------------------------------

const CROCKFORD_BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeCrockfordBase32(value: bigint, length: number): string {
  let result = '';
  let remaining = value;
  for (let i = 0; i < length; i += 1) {
    const index = Number(remaining % 32n);
    result = CROCKFORD_BASE32_ALPHABET[index] + result;
    remaining /= 32n;
  }
  return result;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/**
 * Generates a short, sortable, collision-resistant ID of the form
 * `${prefix}_` followed by a 26-character ULID-style body: a 10-char
 * (48-bit) millisecond timestamp then a 16-char (80-bit) random
 * component, both Crockford Base32.
 */
export function generateId(prefix: string, now: number = Date.now()): string {
  const timestampPart = encodeCrockfordBase32(BigInt(now), 10);
  const randomPart = encodeCrockfordBase32(bytesToBigInt(randomBytes(10)), 16);
  return `${prefix}_${timestampPart}${randomPart}`;
}

/** Generates an `errorId`, e.g. `e_01J9X4Q2M5K8...` — matches ARCHITECTURE.md §7.1's example shape. */
export function generateErrorId(): string {
  return generateId('e');
}

// ---------------------------------------------------------------------------
// Response envelope + Fastify error handler
// ---------------------------------------------------------------------------

export interface ApiErrorResponseBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly errorId: string;
    readonly details: unknown;
  };
}

/** Builds the §7.1 envelope body. Exported so call sites that need to produce one outside the error handler itself (e.g. a 404 fallback) don't hand-roll the shape. */
export function buildEnvelope(
  code: ErrorCode,
  message: string,
  errorId: string,
  details: unknown = null,
): ApiErrorResponseBody {
  return { error: { code, message, errorId, details } };
}

/** Duck-types Fastify/Node framework errors (404, payload-too-large, bad JSON, …), which carry `statusCode` but are not our `AppError`. */
function getFrameworkStatusCode(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const status = (err as { statusCode?: unknown }).statusCode;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

/** Generic, safe messages for framework-level HTTP errors — never the framework's own (potentially detail-leaking) message text. */
const FRAMEWORK_STATUS_CODES: Record<
  number,
  { readonly code: ErrorCode; readonly message: string }
> = {
  400: { code: 'VALIDATION_FAILED', message: 'The request could not be understood.' },
  401: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
  403: { code: 'FORBIDDEN', message: 'You are not permitted to perform this action.' },
  404: { code: 'NOT_FOUND', message: 'That route does not exist.' },
  405: { code: 'VALIDATION_FAILED', message: 'That method is not allowed on this route.' },
  409: {
    code: 'CONFLICT',
    message: 'The request conflicts with the current state of the resource.',
  },
  413: { code: 'VALIDATION_FAILED', message: 'The request body is too large.' },
  415: { code: 'VALIDATION_FAILED', message: 'Unsupported content type.' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
};

const GENERIC_INTERNAL_MESSAGE =
  'Something went wrong. Quote this error ID if you contact support.';

/**
 * Builds the Fastify error handler. Every branch logs the full detail
 * server-side (`logger`) under the same `errorId` that goes to the
 * client, so an admin can quote the ID and a maintainer can find the
 * real cause — the client response itself never carries a stack trace
 * or an internal message (SECURITY.md).
 */
export function createErrorHandler(logger: Logger) {
  return function errorHandler(err: unknown, request: FastifyRequest, reply: FastifyReply): void {
    const errorId = generateErrorId();

    if (err instanceof AppError) {
      const logMethod = err.httpStatus >= 500 ? 'error' : 'warn';
      logger[logMethod](
        { err, errorId, code: err.code, reqId: request.id, httpStatus: err.httpStatus },
        err.message,
      );
      void reply
        .status(err.httpStatus)
        .send(buildEnvelope(err.code, err.message, errorId, err.details));
      return;
    }

    const frameworkStatus = getFrameworkStatusCode(err);
    if (frameworkStatus !== undefined && frameworkStatus < 500) {
      const mapped = FRAMEWORK_STATUS_CODES[frameworkStatus] ?? {
        code: 'VALIDATION_FAILED' as const,
        message: 'The request could not be processed.',
      };
      logger.warn({ err, errorId, reqId: request.id, httpStatus: frameworkStatus }, mapped.message);
      void reply.status(frameworkStatus).send(buildEnvelope(mapped.code, mapped.message, errorId));
      return;
    }

    // Unknown/unexpected error, or a framework 5xx: never leak err.message
    // or a stack trace to the client. Full detail (including the real
    // error) goes to the server log only, correlated by errorId.
    logger.error({ err, errorId, reqId: request.id }, 'Unhandled error');
    void reply.status(500).send(buildEnvelope('INTERNAL', GENERIC_INTERNAL_MESSAGE, errorId));
  };
}

/** Runtime guard used by tests/call sites that need to confirm a decoded envelope's code is one we actually issue. */
export function isKnownErrorCode(value: unknown): value is ErrorCode {
  return isErrorCode(value);
}
