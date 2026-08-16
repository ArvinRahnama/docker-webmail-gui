/**
 * Stable API error codes — part of the API contract (ARCHITECTURE.md
 * §7.1). Every error the server returns carries one of these in its
 * envelope's `error.code`. Treat this list as append-only: a consumer
 * (the SPA, a script quoting an `errorId` in a bug report, a future
 * integration) may already be branching on a code, so removing or
 * renaming one is a breaking change.
 *
 * M2 ships only the generic, cross-cutting codes every route can raise.
 * Domain-specific codes (e.g. a hypothetical `MAILBOX_NOT_FOUND`) land
 * alongside the features that raise them in later milestones — adding
 * one is just appending a literal here, which is what makes contract
 * drift between server and client a compile error rather than a
 * runtime surprise.
 */
export const ERROR_CODES = [
  /** Request payload or query/path parameters failed schema validation. */
  'VALIDATION_FAILED',
  /** No valid session — the caller needs to log in. */
  'UNAUTHENTICATED',
  /** Authenticated, but not permitted to perform this action. */
  'FORBIDDEN',
  /**
   * A supplied credential (login password, or current password on a
   * change-password request) did not verify. Deliberately distinct from
   * `UNAUTHENTICATED` ("no session at all") — this is the uniform
   * failure for login (unknown email, wrong password, locked-out
   * account and disabled account are all indistinguishable, by design:
   * SECURITY.md §3.5) and for a wrong current-password on a
   * change-password request, where the caller *does* have a valid
   * session but has not proven possession of the current password.
   */
  'INVALID_CREDENTIALS',
  /**
   * The authenticated admin must change their password (bootstrap or
   * admin-created account) before any other route is usable.
   * ARCHITECTURE.md / M3: "force the change before any other route is
   * usable."
   */
  'PASSWORD_CHANGE_REQUIRED',
  /** The requested resource does not exist (or is not visible to this caller). */
  'NOT_FOUND',
  /** The request conflicts with the current state of the resource. */
  'CONFLICT',
  /** The caller has exceeded a rate limit; retry later. */
  'RATE_LIMITED',
  /** A dependency this request needed (broker, Docker, Rspamd, …) was unreachable or errored. */
  'UPSTREAM_UNAVAILABLE',
  /**
   * The request was well-formed and targets a real route, but this
   * deployment's capability document (`drivers/dms/capabilities.ts`) says
   * the underlying operation cannot work here — e.g. a quota mutation
   * while `ENABLE_QUOTAS` is off, or local mailbox/alias writes under
   * `ACCOUNT_PROVISIONER=LDAP` (FEATURE_MATRIX.md §7; M7). Distinct from
   * `VALIDATION_FAILED` (the request itself is fine) and from
   * `UPSTREAM_UNAVAILABLE` (nothing is unreachable — the deployment simply
   * does not have this feature turned on).
   */
  'CAPABILITY_UNSUPPORTED',
  /** An unexpected server-side failure. Never carries internal detail — see errorId. */
  'INTERNAL',
] as const;

/** A stable API error code. See {@link ERROR_CODES}. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Runtime check that a value is one of the known {@link ERROR_CODES}. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}
