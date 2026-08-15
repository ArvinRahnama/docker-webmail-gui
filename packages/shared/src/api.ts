/**
 * Zod schemas for the API's uniform shapes (ARCHITECTURE.md §7.1). These
 * are the *same artifact* used for runtime validation on the server and
 * for static types on both server and client, per ARCHITECTURE.md §3 —
 * a schema change here is felt everywhere it's consumed, at compile
 * time, rather than discovered at runtime.
 */
import { z } from 'zod';
import { ERROR_CODES } from './errors.js';

/** The error code enum, as a Zod schema. */
export const ErrorCodeSchema = z.enum(ERROR_CODES);

/** Any value that survives a `JSON.stringify`/`JSON.parse` round trip. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * `error.details` is serialised as JSON and reaches the client as JSON,
 * so it is typed as an actual JSON value rather than `unknown`.
 * `unknown` (with or without `.nullable()`) also admits `undefined`,
 * functions and symbols — none of which survive
 * `JSON.stringify`/`JSON.parse` — and critically, because `undefined`
 * is an accepted value, a *missing* `details` key would silently pass
 * validation too (Zod treats an absent key the same as an explicit
 * `undefined`). This schema is recursive so nested objects/arrays
 * within `details` (e.g. a list of field-validation issues) are
 * actually validated, not just present.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * `details` carries non-sensitive, error-code-specific detail (e.g. a
 * list of field-validation issues for `VALIDATION_FAILED`) and is
 * always present — `null` when there is none — matching
 * ARCHITECTURE.md §7.1's example exactly rather than making callers
 * branch on whether the key exists.
 */
export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  errorId: z.string(),
  details: JsonValueSchema,
});

/** The full uniform error envelope: `{ "error": { ... } }`. */
export const ApiErrorEnvelopeSchema = z.object({
  error: ApiErrorSchema,
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;

/**
 * `GET /api/v1/health` response. Deliberately minimal for M2: a
 * liveness/version probe, not the multi-subsystem `Healthy | Warning |
 * Critical | Unknown` health engine described in ARCHITECTURE.md §7.7
 * (that engine, with its per-check caching and `health/` module, is a
 * later milestone; this schema only covers "is the process up").
 */
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  /** Application version, e.g. `"0.1.0"` — see {@link APP_VERSION}. */
  version: z.string(),
  /** Process uptime in seconds. */
  uptime: z.number().nonnegative(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
