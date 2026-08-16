/**
 * Session tokens and CSRF tokens (ARCHITECTURE.md §7.4; SECURITY.md
 * §3.5, §3.6). No cryptography is hand-rolled: generation is
 * `crypto.randomBytes`, hashing is `crypto.createHash('sha256')`,
 * comparison is `crypto.timingSafeEqual`.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Bytes of CSPRNG entropy in a session or CSRF token before encoding. 256 bits — not brute-forceable. */
const TOKEN_BYTES = 32;

/**
 * A fresh, unguessable session token, base64url-encoded (URL/cookie
 * safe, no padding). Only this token's *hash* is ever stored — see
 * {@link hashToken}.
 */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * A fresh, unguessable per-session CSRF token. Unlike the session
 * token, this is stored server-side in **plaintext** — see migration
 * 002's comment for why that is safe here (it is not itself a bearer
 * credential; the `HttpOnly; SameSite=Strict` session cookie is, and a
 * cross-site page cannot obtain that).
 */
export function generateCsrfToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * SHA-256 (deliberately not Argon2) is the right tool here: a session
 * token is 256 bits of CSPRNG output, not a human-chosen secret with
 * exploitable structure, so it is already computationally infeasible to
 * brute-force and gains nothing from a slow KDF. Every authenticated
 * request needs a token lookup, so running Argon2 on each one would add
 * real, user-visible latency across the whole application for no
 * corresponding security benefit — a self-inflicted denial of service.
 * A fast cryptographic hash is exactly right for "look up a
 * high-entropy random value by its hash."
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time string equality for secret comparisons (the CSRF token
 * check; SECURITY.md §3.5/§3.6 both call for `crypto.timingSafeEqual`).
 * Compares SHA-256 digests of the inputs rather than the raw strings:
 * `timingSafeEqual` throws on a length mismatch, and the two values
 * compared here (a stored token and a client-submitted header) cannot
 * be assumed to be the same length. Hashing first guarantees two
 * fixed-length (32-byte) buffers, so the comparison is both always safe
 * to call and free of any length-based timing signal.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
