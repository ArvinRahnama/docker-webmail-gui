/**
 * `application/x-www-form-urlencoded` body parsing without a dependency.
 * OAuth (RFC 6749 §3.1, §3.2) forbids repeating a parameter; a body that
 * repeats any key is rejected outright rather than "last one wins".
 */
import type { FastifyInstance } from 'fastify';

export const FORM_BODY_LIMIT_BYTES = 16 * 1024;

export class DuplicateParameterError extends Error {
  readonly statusCode = 400;
  constructor(readonly parameter: string) {
    super(`The "${parameter}" parameter must appear at most once.`);
    this.name = 'DuplicateParameterError';
  }
}

export function parseFormBody(raw: string): Record<string, string> {
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of params) {
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new DuplicateParameterError(key);
    out[key] = value;
  }
  return out;
}

export function registerFormBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: FORM_BODY_LIMIT_BYTES },
    (_request, body, done) => {
      try {
        done(null, parseFormBody(typeof body === 'string' ? body : body.toString('utf8')));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );
}
