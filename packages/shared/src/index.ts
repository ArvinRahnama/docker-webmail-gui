/**
 * @dwg/shared
 *
 * Home for the Zod schemas, DTO types, constants and error codes shared by
 * `apps/server`, `apps/broker` and `apps/web` — per ARCHITECTURE.md §3, the
 * *same* schema artifact backs both runtime validation and static types, so
 * contract drift between the API and its consumers becomes a compile error
 * instead of a runtime surprise.
 *
 * This package is a stub for milestone M1 (repository foundation). Real
 * schemas and DTOs land alongside the API surface they describe, starting
 * at M2 — see IMPLEMENTATION_PLAN.md §3.
 */

/** Package version. Kept in lockstep with this package's package.json. */
export const VERSION = '0.1.0';

/**
 * Placeholder shared type, deliberately not backed by a Zod schema yet.
 * It exists only so `apps/server`, `apps/broker` and `apps/web` have a
 * real cross-package import to typecheck against before the first actual
 * DTO ships. Replace/remove once real shared types land.
 */
export type PlaceholderDto = {
  readonly id: string;
};
