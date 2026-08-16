/**
 * The broker's minimal error model. Deliberately smaller than
 * `apps/server/src/platform/errors.ts`: this is an internal-only
 * protocol between the server and the broker (never a browser-facing
 * response), so there is no `errorId`/log-correlation machinery here —
 * just a stable code, an HTTP status, and a message that is safe to
 * return, with full detail always going to the broker's own log first
 * (SECURITY.md — never leak a stack trace or an internal message to the
 * caller).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { ErrorCode } from '@dwg/shared';

const DEFAULT_HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  UPSTREAM_UNAVAILABLE: 502,
  INTERNAL: 500,
};

/** The error type routes/operations throw for any expected failure. Reuses `@dwg/shared`'s `ErrorCode` enum so the server can branch on the same stable codes it already knows from `/api/v1/*`. */
export class BrokerError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'BrokerError';
    this.code = code;
    this.httpStatus = httpStatus ?? DEFAULT_HTTP_STATUS[code] ?? 500;
  }
}

export interface BrokerErrorBody {
  readonly error: { readonly code: ErrorCode; readonly message: string };
}

export function buildBrokerErrorBody(code: ErrorCode, message: string): BrokerErrorBody {
  return { error: { code, message } };
}

function getFrameworkStatusCode(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const status = (err as { statusCode?: unknown }).statusCode;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

/** Builds the Fastify error handler. Every branch logs full detail server-side under the broker's own logger; the client response never carries a stack trace or an internal message. */
export function createBrokerErrorHandler(logger: Logger) {
  return function errorHandler(err: unknown, request: FastifyRequest, reply: FastifyReply): void {
    if (err instanceof BrokerError) {
      const level = err.httpStatus >= 500 ? 'error' : 'warn';
      logger[level]({ err, code: err.code, reqId: request.id }, err.message);
      void reply.status(err.httpStatus).send(buildBrokerErrorBody(err.code, err.message));
      return;
    }

    const frameworkStatus = getFrameworkStatusCode(err);
    if (frameworkStatus !== undefined && frameworkStatus < 500) {
      logger.warn(
        { err, reqId: request.id, httpStatus: frameworkStatus },
        'Rejected malformed request',
      );
      void reply
        .status(frameworkStatus)
        .send(buildBrokerErrorBody('VALIDATION_FAILED', 'The request could not be processed.'));
      return;
    }

    logger.error({ err, reqId: request.id }, 'Unhandled broker error');
    void reply.status(500).send(buildBrokerErrorBody('INTERNAL', 'Internal broker error.'));
  };
}
