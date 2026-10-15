/**
 * Error types for apps/mcp's three surfaces, each with the error format its
 * protocol requires:
 *
 *  - Control API (apps/server → apps/mcp): the project's uniform envelope
 *    `{ error: { code, message, errorId, details } }` (ARCHITECTURE.md §7.1),
 *    so apps/server can surface the same codes to the SPA.
 *  - OAuth endpoints: RFC 6749 §5.2 `{ error, error_description }`.
 *  - MCP resource requests: RFC 6750 bearer challenges (built in oauth/bearer.ts).
 *
 * No surface ever returns a stack trace, an internal path, a credential, or
 * any detail about a mailbox the caller is not bound to.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { ErrorCode } from '@dwg/shared';

const DEFAULT_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 502,
  CAPABILITY_UNSUPPORTED: 409,
  INTERNAL: 500,
  INVALID_CREDENTIALS: 401,
  PASSWORD_CHANGE_REQUIRED: 403,
};

export class ControlError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: unknown;
  constructor(
    code: ErrorCode,
    message: string,
    options: { httpStatus?: number; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? DEFAULT_HTTP_STATUS[code];
    this.details = options.details ?? null;
  }
}

export function generateErrorId(): string {
  return `e_${randomBytes(10).toString('hex')}`;
}

export function createControlErrorHandler(logger: Logger) {
  return (err: unknown, request: FastifyRequest, reply: FastifyReply): void => {
    const errorId = generateErrorId();
    if (err instanceof ControlError) {
      logger[err.httpStatus >= 500 ? 'error' : 'warn'](
        { errorId, code: err.code, reqId: request.id, msg: err.message },
        'control request failed',
      );
      void reply.status(err.httpStatus).send({
        error: { code: err.code, message: err.message, errorId, details: err.details },
      });
      return;
    }
    const status =
      typeof err === 'object' && err !== null && 'statusCode' in err
        ? Number((err as { statusCode: unknown }).statusCode)
        : 500;
    if (status >= 400 && status < 500) {
      logger.warn({ errorId, reqId: request.id, status }, 'control request rejected');
      void reply.status(status).send({
        error: {
          code: status === 429 ? 'RATE_LIMITED' : 'VALIDATION_FAILED',
          message: 'The request could not be processed.',
          errorId,
          details: null,
        },
      });
      return;
    }
    logger.error({ err, errorId, reqId: request.id }, 'unhandled control error');
    void reply.status(500).send({
      error: {
        code: 'INTERNAL',
        message: 'Something went wrong in the MCP service. Quote this error ID.',
        errorId,
        details: null,
      },
    });
  };
}

/** RFC 6749 §5.2 / RFC 7591 §3.2.2 / RFC 7009 error. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly httpStatus: number = 400,
  ) {
    super(description);
    this.name = 'OAuthError';
  }
}

export function sendOAuthError(reply: FastifyReply, err: OAuthError): void {
  void reply
    .status(err.httpStatus)
    .header('cache-control', 'no-store')
    .header('pragma', 'no-cache')
    .send({ error: err.error, error_description: err.description });
}

export function parseWith<T>(
  schema: {
    safeParse(
      input: unknown,
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
  },
  input: unknown,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ControlError('VALIDATION_FAILED', 'The request failed validation.', {
      details: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}
