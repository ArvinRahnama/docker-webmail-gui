/**
 * Shared-secret authentication (ARCHITECTURE.md §6; SECURITY.md §3.1,
 * Part 5 item 3). Every request must carry the correct
 * `x-broker-secret` header, compared in constant time. No cryptography
 * is hand-rolled: comparison is `crypto.timingSafeEqual` over SHA-256
 * digests of both inputs — hashing first guarantees two fixed-length
 * (32-byte) buffers, so the comparison is always safe to call regardless
 * of the provided header's length, and carries no length-based timing
 * signal (the same technique `apps/server/src/modules/auth/tokens.ts`
 * uses for CSRF tokens — duplicated here in miniature rather than
 * imported, because the broker and the web tier are separate deployables
 * that share only `@dwg/shared`, by design: ARCHITECTURE.md §4).
 *
 * This module is wired as a Fastify `onRequest` hook (see `app.ts`),
 * which runs before Fastify parses the request body — "reject before any
 * parsing" is a property of *where* this hook is registered, not of this
 * function's own logic.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { BROKER_SECRET_HEADER } from '@dwg/shared';
import { BrokerError } from './errors.js';

/** Constant-time string equality. Always safe to call — never throws on a length mismatch, unlike a bare `crypto.timingSafeEqual` on the raw inputs. */
export function secretsMatch(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/** Builds the `onRequest` guard for a configured shared secret. Throws `BrokerError('UNAUTHENTICATED', …)` — formatted by the broker's own error handler — for a missing, empty, or mismatched header. */
export function createSecretGuard(sharedSecret: string) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers[BROKER_SECRET_HEADER];
    const provided = typeof header === 'string' ? header : '';

    if (provided.length === 0 || !secretsMatch(provided, sharedSecret)) {
      throw new BrokerError('UNAUTHENTICATED', 'Missing or invalid broker secret.');
    }
  };
}
